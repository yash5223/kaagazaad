const PLAN_ORDER = [ "free", "basic", "premium" ];
const PLAN_LABELS = {
  free: "Free",
  basic: "Basic",
  premium: "Premium"
};
const LIMITS = {
  free: {
    documents: 5,
    smartScan: false,
    voiceSearch: false,
    folders: false,
    cloudBackup: false,
    warranties: 1,
    insights: false,
    lifeEvents: 0,
    familyVault: false,
    familyMembers: 0,
    aiAssistant: 0,
    downloads: false,
    share: false,
    fullAnalytics: false,
    emailSupport: false,
    prioritySupport: false
  },
  basic: {
    documents: 100,
    smartScan: true,
    voiceSearch: true,
    folders: true,
    cloudBackup: true,
    warranties: null,
    insights: true,
    lifeEvents: 1,
    familyVault: false,
    familyMembers: 0,
    aiAssistant: 20,
    downloads: true,
    share: true,
    fullAnalytics: false,
    emailSupport: true,
    prioritySupport: false
  },
  premium: {
    documents: null,
    smartScan: true,
    voiceSearch: true,
    folders: true,
    cloudBackup: true,
    warranties: null,
    insights: true,
    lifeEvents: null,
    familyVault: true,
    familyMembers: 5,
    aiAssistant: null,
    downloads: true,
    share: true,
    fullAnalytics: true,
    emailSupport: true,
    prioritySupport: true
  }
};
const FEATURE_LABELS = {
  documents: "document storage",
  smartScan: "Smart scan & auto-fill",
  voiceSearch: "Voice search",
  folders: "Custom folders & tags",
  cloudBackup: "Cloud backup & sync",
  warranties: "Warranty tracking",
  insights: "Spending insights",
  lifeEvents: "Life Event checklists",
  familyVault: "Family Vault",
  familyMembers: "Family Vault members",
  aiAssistant: "AI assistant",
  downloads: "Offline downloads",
  share: "Share & export",
  fullAnalytics: "Full spending analytics",
  emailSupport: "Email support",
  prioritySupport: "Priority support"
};
function normalizePlan(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return "free";
  if (/premium|yearly|annual|pro/.test(value)) return "premium";
  if (/basic|monthly|plus|standard/.test(value)) return "basic";
  return "free";
}
function limitFor(plan, feature) {
  const table = LIMITS[normalizePlan(plan)] || LIMITS.free;
  return table[feature];
}
function checkAccess(plan, feature, used = 0) {
  const limit = limitFor(plan, feature);
  if (limit === null) return { allowed: true, limit: null };
  if (typeof limit === "boolean") return { allowed: limit, limit };
  return { allowed: used < limit, limit };
}
function nextPlanFor(plan, feature) {
  const current = PLAN_ORDER.indexOf(normalizePlan(plan));
  const currentLimit = limitFor(plan, feature);
  for (let i = current + 1; i < PLAN_ORDER.length; i++) {
    const candidate = LIMITS[PLAN_ORDER[i]][feature];
    if (candidate === null) return PLAN_ORDER[i];
    if (typeof candidate === "boolean" && candidate && !currentLimit) return PLAN_ORDER[i];
    if (typeof candidate === "number" && typeof currentLimit === "number" && candidate > currentLimit) return PLAN_ORDER[i];
  }
  return null;
}
function buildMessage(plan, feature, limit) {
  const planKey = normalizePlan(plan);
  const label = PLAN_LABELS[planKey];
  const nextKey = nextPlanFor(planKey, feature);
  const nextLabel = nextKey ? PLAN_LABELS[nextKey] : null;
  const name = FEATURE_LABELS[feature] || feature;
  const upgrade = nextLabel ? ` Upgrade to the ${nextLabel} plan to continue.` : "";
  if (feature === "documents") {
    const nextLimit = nextKey ? LIMITS[nextKey].documents : undefined;
    const bonus = nextKey ? (nextLimit === null ? " and store unlimited documents" : ` and store up to ${nextLimit} documents`) : "";
    return `You've used all ${limit} documents allowed on the ${label} plan.${nextLabel ? ` Buy the ${nextLabel} plan${bonus}.` : ""}`;
  }
  if (feature === "aiAssistant" && typeof limit === "number" && limit > 0) {
    return `You've used all ${limit} AI queries for this month on the ${label} plan.${upgrade}`;
  }
  if (feature === "familyMembers" && typeof limit === "number" && limit > 0) {
    return `Your ${label} plan allows up to ${limit} family members.${upgrade}`;
  }
  if (typeof limit === "number" && limit > 0) {
    return `You've reached the ${name} limit (${limit}) on the ${label} plan.${upgrade}`;
  }
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} isn't included in the ${label} plan.${upgrade}`;
}
function sendPlanLimit(res, plan, feature, limit, usage = {}) {
  const currentPlan = normalizePlan(plan);
  return res.status(403).json({
    error: buildMessage(currentPlan, feature, limit),
    code: "PLAN_LIMIT",
    feature: feature,
    currentPlan: currentPlan,
    requiredPlan: nextPlanFor(currentPlan, feature),
    recommendedPlan: recommendPlan({ plan: currentPlan, status: "active", feature: feature, usage: usage }),
    includedIn: plansIncluding(feature),
    limit: limit
  });
}
function currentMonthKey(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}
function getPlanState(user, now = new Date()) {
  const raw = String((user && user.subscription_plan) || "").trim();
  if (!raw) return { status: "none", plan: null, expiresAt: null };
  const plan = normalizePlan(raw);
  const expiresAt = user.plan_expires_at ? new Date(user.plan_expires_at) : null;
  if (plan !== "free" && expiresAt && expiresAt.getTime() <= now.getTime()) {
    return { status: "expired", plan, expiresAt };
  }
  return { status: "active", plan, expiresAt };
}
const PLAN_CHANGE_WINDOW_MS = 24 * 60 * 60 * 1000;
function checkPlanChange(state, targetPlan, now = new Date()) {
  if (!state || state.status !== "active" || !state.plan || state.plan === "free" || !state.expiresAt) {
    return { allowed: true, changeOpensAt: null };
  }
  const isUpgrade = PLAN_ORDER.indexOf(normalizePlan(targetPlan)) > PLAN_ORDER.indexOf(state.plan);
  if (isUpgrade) return { allowed: true, changeOpensAt: null };
  const changeOpensAt = new Date(state.expiresAt.getTime() - PLAN_CHANGE_WINDOW_MS);
  return { allowed: now.getTime() >= changeOpensAt.getTime(), changeOpensAt };
}
function planCovers(planKey, feature, used = 0) {
  const limit = LIMITS[planKey][feature];
  if (limit === null) return true;
  if (typeof limit === "boolean") return limit;
  return used < limit;
}
function recommendPlan({ plan = null, status = "active", feature = null, usage = {} } = {}) {
  const current = plan ? PLAN_ORDER.indexOf(normalizePlan(plan)) : -1;
  let candidates;
  if (status === "active") candidates = PLAN_ORDER.slice(current + 1);
  else if (status === "expired") candidates = PLAN_ORDER.slice(Math.max(current, 1));
  else candidates = PLAN_ORDER.slice();
  if (candidates.length === 0) return null;
  const docs = Number(usage.documents) || 0;
  for (const key of candidates) {
    const docLimit = LIMITS[key].documents;
    const docsFit = docLimit === null || docs <= docLimit;
    const featureFits = feature ? planCovers(key, feature, feature === "documents" ? docs : 0) : true;
    if (docsFit && featureFits) return key;
  }
  return candidates[candidates.length - 1];
}
function plansIncluding(feature) {
  return PLAN_ORDER.filter(key => planCovers(key, feature, 0));
}
function sendPlanRequired(res, state, usage = {}) {
  const expired = state.status === "expired";
  const label = state.plan ? PLAN_LABELS[state.plan] : null;
  const recommended = recommendPlan({ plan: state.plan, status: state.status, usage });
  return res.status(402).json({
    error: expired
      ? `Your ${label} plan has expired. Renew a plan to keep using Kaagazaad.`
      : "Choose a plan to start using Kaagazaad.",
    code: "PLAN_REQUIRED",
    reason: state.status,
    currentPlan: state.plan,
    expiresAt: state.expiresAt,
    recommendedPlan: recommended
  });
}
module.exports = {
  PLAN_ORDER,
  PLAN_LABELS,
  LIMITS,
  normalizePlan,
  limitFor,
  checkAccess,
  nextPlanFor,
  buildMessage,
  sendPlanLimit,
  currentMonthKey,
  getPlanState,
  checkPlanChange,
  planCovers,
  recommendPlan,
  plansIncluding,
  sendPlanRequired
};
