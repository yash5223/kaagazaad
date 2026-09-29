const User = require("../models/User");
const {
  getPlanState,
  checkAccess,
  sendPlanLimit,
  sendPlanRequired,
  normalizePlan,
  currentMonthKey
} = require("../utils/planLimits");
async function loadPlanUser(req) {
  if (req.planUser) return req.planUser;
  const user = await User.findById(req.user.id).select("subscription_plan plan_expires_at customer_id ai_usage");
  req.planUser = user;
  return user;
}
async function requireActivePlan(req, res, next) {
  try {
    const user = await loadPlanUser(req);
    if (!user) return res.status(401).json({ error: "Invalid user account credentials." });
    const state = getPlanState(user);
    req.planState = state;
    if (state.status !== "active") return sendPlanRequired(res, state);
    return next();
  } catch (err) {
    return next(err);
  }
}
function requireFeature(feature) {
  return async function planFeatureGuard(req, res, next) {
    try {
      const user = await loadPlanUser(req);
      if (!user) return res.status(401).json({ error: "Invalid user account credentials." });
      const access = checkAccess(user.subscription_plan, feature, 0);
      if (!access.allowed) return sendPlanLimit(res, user.subscription_plan, feature, access.limit);
      return next();
    } catch (err) {
      return next(err);
    }
  };
}
function aiUsedThisMonth(user) {
  const usage = user && user.ai_usage;
  return usage && usage.month === currentMonthKey() ? usage.count || 0 : 0;
}
async function requireAiQuota(req, res, next) {
  try {
    const user = await loadPlanUser(req);
    if (!user) return res.status(401).json({ error: "Invalid user account credentials." });
    const used = aiUsedThisMonth(user);
    const access = checkAccess(user.subscription_plan, "aiAssistant", used);
    if (!access.allowed) return sendPlanLimit(res, user.subscription_plan, "aiAssistant", access.limit, { aiAssistant: used });
    const month = currentMonthKey();
    if (user.ai_usage && user.ai_usage.month === month) {
      await User.updateOne({ _id: user._id }, { $inc: { "ai_usage.count": 1 } });
    } else {
      await User.updateOne({ _id: user._id }, { $set: { ai_usage: { month: month, count: 1 } } });
    }
    return next();
  } catch (err) {
    return next(err);
  }
}
async function activatePlan(userId, plan, days) {
  const key = normalizePlan(plan);
  let expiresAt = null;
  if (key !== "free") {
    const existing = await User.findById(userId).select("subscription_plan plan_expires_at");
    const state = getPlanState(existing);
    const base = state.status === "active" && state.expiresAt && state.expiresAt > new Date() ? state.expiresAt : new Date();
    expiresAt = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
  }
  await User.updateOne({ _id: userId }, { $set: { subscription_plan: key, plan_expires_at: expiresAt } });
  return { plan: key, expiresAt };
}
module.exports = { requireActivePlan, requireFeature, requireAiQuota, activatePlan, aiUsedThisMonth };
