const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";
const OTP_COPY = {
  password_reset: {
    subject: "Your Kaagazaad password reset code",
    heading: "Reset your password",
    intro: "Use the code below to reset your Kaagazaad account password. This code expires in 5 minutes.",
    textLabel: "password reset code"
  },
  register: {
    subject: "Verify your email for Kaagazaad",
    heading: "Verify your email",
    intro: "Use the code below to confirm this email address belongs to you and finish creating your Kaagazaad account. This code expires in 10 minutes.",
    textLabel: "email verification code"
  }
};
async function sendOtpEmail(toEmail, otpCode, purpose = "password_reset") {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    throw new Error("BREVO_API_KEY is not configured.");
  }
  const fromAddress = process.env.SMTP_FROM;
  if (!fromAddress) {
    throw new Error("SMTP_FROM is not configured.");
  }
  const copy = OTP_COPY[purpose] || OTP_COPY.password_reset;
  const response = await fetch(BREVO_API_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "api-key": apiKey,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      sender: {
        name: "Kaagazaad",
        email: fromAddress
      },
      to: [ {
        email: toEmail
      } ],
      subject: copy.subject,
      htmlContent: `\n        <div style="font-family: -apple-system, Roboto, Arial, sans-serif; max-width: 420px; margin: 0 auto; padding: 24px; color: #0B1F3D;">\n          <h2 style="margin-bottom: 8px;">${copy.heading}</h2>\n          <p style="color:#4A5568; font-size: 14px; line-height: 1.5;">\n            ${copy.intro}\n          </p>\n          <div style="font-family: monospace; font-size: 32px; font-weight: 700; letter-spacing: 8px; background:#F1F3F6; border-radius: 12px; padding: 20px; text-align: center; margin: 20px 0;">\n            ${otpCode}\n          </div>\n          <p style="color:#94A3B8; font-size: 12px;">\n            If you didn't request this, you can safely ignore this email.\n          </p>\n        </div>\n      `,
      textContent: `Your Kaagazaad ${copy.textLabel} is: ${otpCode}`
    })
  });
  if (!response.ok) {
    let detail = "";
    try {
      const errBody = await response.json();
      detail = errBody.message || JSON.stringify(errBody);
    } catch {
      detail = await response.text();
    }
    throw new Error(`Brevo API error (${response.status}): ${detail}`);
  }
}
module.exports = {
  sendOtpEmail: sendOtpEmail
};