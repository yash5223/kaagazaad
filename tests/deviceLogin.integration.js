process.env.JWT_SECRET='x'.repeat(48); process.env.OTP_HASH_SECRET='y'.repeat(32);
process.env.ALLOWED_ORIGINS='https://app.example.com'; process.env.NODE_ENV='test';
const path=require('path'); const R=p=>require.resolve(path.join(process.cwd(),p));
const stub=(p,exports)=>{const f=R(p);require.cache[f]={id:f,filename:f,loaded:true,exports};};
const bcrypt=require('bcryptjs');
const users=[]; const otps=[]; let mails=[]; const alerts=[];
class U{constructor(o){Object.assign(this,o);} async save(){return this;} get fullName(){return 'Test User';}}
const User={
  findOne:async q=>users.find(u=>u.email===q.email)||null,
  findById:async id=>users.find(u=>String(u._id)===String(id))||null,
  updateOne:async(f,upd)=>{const u=users.find(x=>String(x._id)===String(f._id));if(!u)return;
    if(upd.$push&&upd.$push.trustedDevices){u.trustedDevices=(u.trustedDevices||[]).concat(upd.$push.trustedDevices.$each).slice(upd.$push.trustedDevices.$slice);}
    if(upd.$set){for(const k in upd.$set){if(k.includes('$'))continue;u[k]=upd.$set[k];}}},
  syncIndexes(){}};
stub('models/User.js',User);
stub('models/Otp.js',{
  findOne:async q=>otps.find(o=>o.contactInfo===q.contactInfo&&o.purpose===q.purpose)||null,
  deleteMany:async q=>{for(let i=otps.length-1;i>=0;i--)if(otps[i].contactInfo===q.contactInfo&&(!q.purpose||otps[i].purpose===q.purpose))otps.splice(i,1);},
  deleteOne:async q=>{const i=otps.findIndex(o=>o._id===q._id);if(i>=0)otps.splice(i,1);},
  create:async d=>{const o={...d,_id:Math.random().toString(36),attempts:0};otps.push(o);return o;},
  findOneAndUpdate:async(q,u)=>{const o=otps.find(o=>o.contactInfo===q.contactInfo&&o.purpose===q.purpose&&o.attempts<q.attempts.$lt&&o.expiresAt>q.expiresAt.$gt);if(!o)return null;o.attempts+=u.$inc.attempts;return o;},
  updateOne:async(q,u)=>{const o=otps.find(o=>o._id===q._id);if(o)o.attempts+=u.$inc.attempts;}});
const rts=[];
stub('models/RefreshToken.js',{create:async d=>{const r={...d,usedAt:null};rts.push(r);return r;},
  findOneAndUpdate:async(q,u)=>{const r=rts.find(r=>r.tokenHash===q.tokenHash&&!r.usedAt&&r.expiresAt>q.expiresAt.$gt);if(!r)return null;const before={...r};r.usedAt=u.$set.usedAt;return before;},
  findOne:async q=>rts.find(r=>r.tokenHash===q.tokenHash)||null,
  deleteMany:async q=>{for(let i=rts.length-1;i>=0;i--)if(q.family?rts[i].family===q.family:(q.userId&&q.userId.$in.includes(rts[i].userId)))rts.splice(i,1);}});
stub('utils/securityLog.js',{logSecurityEvent(t){events.push(t);}}); const events=[];
stub('utils/mailer.js',{sendOtpEmail:async(to,code,purpose)=>{mails.push({to,code,purpose});},sendCredentialsEmail:async()=>{}});
stub('routes/alertRoutes.js',{createAlert:async a=>{alerts.push(a.title);},router:require('express').Router()});
stub('middleware/planGuard.js',{activatePlan:async()=>({plan:'free'})});
stub('models/SecurityEvent.js',{create:async()=>{}});
const express=require('express');
const app=express(); app.use(express.json()); app.set('trust proxy',1);
app.use('/api/users',require('./routes/userRoutes'));
const srv=app.listen(0); const B=`http://127.0.0.1:${srv.address().port}/api/users`;
const post=async(p,body,headers={})=>{const r=await fetch(B+p,{method:'POST',headers:{'content-type':'application/json','x-device-verification':'1',...headers},body:JSON.stringify(body)});return {s:r.status,j:await r.json().catch(()=>({})),c:r.headers.getSetCookie?.()||[]};};
let ok=0,bad=0; const t=(name,cond,extra='')=>{cond?ok++:bad++;console.log((cond?'PASS ':'FAIL ')+name+(cond?'':' '+extra));};
(async()=>{
 users.push(new U({_id:'u1',email:'a@b.com',customer_id:'C1',passwordHash:await bcrypt.hash('Passw0rd!',10),tokenVersion:0,pinEnabled:false,trustedDevices:[]}));
 let r0=await fetch(B+'/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'a@b.com',password:'Passw0rd!'})}).then(r=>r.json());
 t('legacy client (no header) still gets tokens',!!r0.token&&!r0.requiresDeviceVerification,JSON.stringify(r0));
 process.env.REQUIRE_DEVICE_VERIFICATION='strict';
 r0=await fetch(B+'/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'a@b.com',password:'Passw0rd!'})}).then(r=>r.json());
 t('strict mode challenges legacy clients too',r0.requiresDeviceVerification===true);
 delete process.env.REQUIRE_DEVICE_VERIFICATION; mails.length=0; otps.length=0;
 let r=await post('/login',{email:'a@b.com',password:'Passw0rd!'});
 t('new device gets challenge',r.s===200&&r.j.requiresDeviceVerification===true&&!r.j.token&&!r.j.refreshToken,JSON.stringify(r.j));
 t('otp email sent',mails.length===1&&mails[0].purpose==='device_login');
 t('password hash upgraded to cost 12',bcrypt.getRounds(users[0].passwordHash)===12);
 const ch=r.j.challengeToken;
 r=await post('/login',{email:'a@b.com',password:'wrong'}); t('wrong password rejected, no mail',r.s===400&&mails.length===1);
 r=await post('/login',{email:'a@b.com',password:'Passw0rd!'}); t('cooldown: no second email',mails.length===1&&r.j.requiresDeviceVerification);
 r=await post('/login/verify-device',{challengeToken:ch,otpCode:'000000'}); t('bad code rejected',r.s===400,JSON.stringify(r.j));
 r=await post('/login/verify-device',{challengeToken:'abc.def.ghi',otpCode:'123456'}); t('forged challenge rejected',r.s===401);
 const {issueAccessToken}=require('./utils/tokens'); r=await post('/login/verify-device',{challengeToken:issueAccessToken(users[0]),otpCode:'123456'}); t('access token not accepted as challenge',r.s===401);
 r=await post('/login/verify-device',{challengeToken:ch,otpCode:mails[0].code,deviceLabel:'Pixel'});
 t('good code issues tokens + deviceToken',r.s===200&&r.j.token&&r.j.refreshToken&&r.j.deviceToken,JSON.stringify(r.j));
 t('device stored hashed',users[0].trustedDevices.length===1&&users[0].trustedDevices[0].tokenHash!==r.j.deviceToken);
 const dev=r.j.deviceToken;
 r=await post('/login/verify-device',{challengeToken:ch,otpCode:mails[0].code}); t('code is single-use',r.s!==200);
 r=await post('/login',{email:'a@b.com',password:'Passw0rd!',deviceToken:dev}); t('trusted device: no OTP',r.s===200&&r.j.token&&!r.j.requiresDeviceVerification);
 r=await post('/login',{email:'a@b.com',password:'Passw0rd!',deviceToken:'z'.repeat(43)}); t('unknown device token => challenge',r.j.requiresDeviceVerification===true);
 users[0].trustedDevices=[]; mails=[]; otps.length=0;
 const web={origin:'https://app.example.com','x-client-platform':'web'};
 r=await post('/login',{email:'a@b.com',password:'Passw0rd!',remember:true},web);
 r=await post('/login/verify-device',{challengeToken:r.j.challengeToken,otpCode:mails[0].code},web);
 t('web: tokens in httpOnly cookies, not body',r.s===200&&r.j.token&&r.j.refreshToken===undefined&&r.j.deviceToken===undefined&&r.c.some(c=>c.startsWith('__Secure-kz_rt=p.')&&/HttpOnly/i.test(c))&&r.c.some(c=>c.startsWith('__Secure-kz_dev=')&&/HttpOnly/i.test(c)),JSON.stringify({b:r.j,c:r.c}));
 const devCookie=r.c.find(c=>c.startsWith('__Secure-kz_dev=')).split(';')[0]; const rtCookie=r.c.find(c=>c.startsWith('__Secure-kz_rt=')).split(';')[0];
 r=await post('/login',{email:'a@b.com',password:'Passw0rd!'},{...web,cookie:devCookie}); t('web: trusted via cookie',r.s===200&&r.j.token,JSON.stringify(r.j));
 r=await post('/refresh',{refreshToken:'attacker-supplied-'+'a'.repeat(30)},{...web,cookie:rtCookie});
 t('web refresh via cookie (body token ignored)',r.s===200&&r.j.token&&r.j.refreshToken===undefined&&r.c.some(c=>c.startsWith('__Secure-kz_rt=p.')),JSON.stringify({s:r.s,j:r.j,c:r.c}));
 const newRt=r.c.find(c=>c.startsWith('__Secure-kz_rt=')).split(';')[0];
 t('refresh cookie rotated',newRt!==rtCookie);
 r=await post('/refresh',{},{cookie:rtCookie.replace('__Secure-kz_rt=','__Secure-kz_rt=')}); t('cookie ignored without web headers (CSRF gate)',r.s===400,JSON.stringify(r.j));
 r=await post('/refresh',{},{origin:'https://evil.com','x-client-platform':'web',cookie:newRt}); t('cookie ignored from foreign origin',r.s===400,JSON.stringify(r.j));
 r=await post('/refresh',{},{...web,cookie:rtCookie}); t('reused old cookie => 401 + cookie cleared',r.s===401&&r.c.some(c=>c.startsWith('__Secure-kz_rt=;')||/Expires=Thu, 01 Jan 1970/.test(c)),JSON.stringify({s:r.s,c:r.c}));
 r=await post('/logout',{},{...web,cookie:newRt}); t('web logout clears cookie',r.s===200&&r.c.some(c=>/Expires=Thu, 01 Jan 1970/.test(c)),JSON.stringify(r.c));
 users[0].trustedDevices=[];
 users[0].trustedDevices=[]; mails=[]; otps.length=0;
 r=await post('/login',{email:'a@b.com',password:'Passw0rd!'}); const ch2=r.j.challengeToken; let last;
 for(let i=0;i<6;i++) last=await post('/login/verify-device',{challengeToken:ch2,otpCode:'111111'});
 r=await post('/login/verify-device',{challengeToken:ch2,otpCode:mails[mails.length-1].code}); t('after 5 bad guesses even the right code is refused',r.s!==200,JSON.stringify(r.j));
 console.log(`\n${ok} passed, ${bad} failed`); srv.close(); process.exit(bad?1:0);
})();
