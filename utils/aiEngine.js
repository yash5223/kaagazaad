function formatINR(value) {
  const num = Math.round(Number(value) || 0);
  const str = Math.abs(num).toString();
  let formatted;
  if (str.length <= 3) {
    formatted = str;
  } else {
    const last3 = str.slice(-3);
    const rest = str.slice(0, -3);
    formatted = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3;
  }
  return (num < 0 ? '-' : '') + '\u20B9' + formatted;
}
function daysBetween(a, b) {
  const MS = 1000 * 60 * 60 * 24;
  return Math.round((b.getTime() - a.getTime()) / MS);
}
function formatDate(d) {
  if (!d) return null;
  const date = new Date(d);
  if (isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}
function parseAmount(text) {
  const cleaned = text.toLowerCase().replace(/[₹,]/g, '');
  const match = cleaned.match(/(\d+(?:\.\d+)?)\s*(k|thousand|l|lakh|lac|cr|crore)?/);
  if (!match) return null;
  let value = parseFloat(match[1]);
  const unit = match[2];
  if (unit === 'k' || unit === 'thousand') value *= 1000;
  else if (unit === 'l' || unit === 'lakh' || unit === 'lac') value *= 100000;
  else if (unit === 'cr' || unit === 'crore') value *= 10000000;
  return value;
}
function extractWindowDays(message) {
  const m = message.match(/(\d+)\s*(day|week|month|year)s?/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2];
    if (unit === 'day') return n;
    if (unit === 'week') return n * 7;
    if (unit === 'month') return n * 30;
    if (unit === 'year') return n * 365;
  }
  if (/this week/.test(message)) return 7;
  if (/this month/.test(message)) return 30;
  return 30;
}
function findMatchingAssets(query, assets, limit = 5) {
  const qWords = query.toLowerCase().match(/[a-z0-9]+/g) || [];
  if (qWords.length === 0) return [];
  const scored = assets.map(asset => {
    const haystack = [
      asset.name, asset.brandOrDeveloper, asset.category, asset.subCategory,
      asset.storeOrSeller, asset.notesOrAddress
    ].filter(Boolean).join(' ').toLowerCase();
    let score = 0;
    qWords.forEach(w => {
      if (w.length < 3) return; 
      if (haystack.includes(w)) score += w.length >= 4 ? 2 : 1;
    });
    return { asset, score };
  });
  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.asset);
}
const STOPWORDS = new Set(['show', 'me', 'my', 'the', 'a', 'an', 'is', 'are', 'was', 'were', 'did', 'do', 'does', 'i', 'when', 'what', 'which', 'how', 'much', 'many', 'purchases', 'purchase', 'buy', 'bought', 'assets', 'asset', 'for', 'of', 'in', 'on', 'to', 'and']);
function extractSearchPhrase(message) {
  const words = (message.toLowerCase().match(/[a-z0-9]+/g) || []).filter(w => !STOPWORDS.has(w));
  return words.join(' ');
}
function detectIntent(message) {
  const m = message.toLowerCase().trim();
  if (/^(hi|hello|hey|yo|good (morning|afternoon|evening))\b/.test(m)) return 'greeting';
  if (/what can you do|help me|how (do|can) i use you|capabilities/.test(m)) return 'help';
  if (/warrant(y|ies)/.test(m)) {
    if (/expired|already ended|no longer valid/.test(m)) return 'warranty_expired';
    return 'warranty_expiring';
  }
  if (/(above|over|more than|greater than|>)\s*₹?\d/.test(m) || /costl(y|ier)/.test(m)) return 'price_above';
  if (/(below|under|less than|<)\s*₹?\d/.test(m)) return 'price_below';
  if (/between\s*₹?\d.*and\s*₹?\d/.test(m)) return 'price_between';
  if (/when did i (buy|get|purchase|register)|purchase date|when was .* (bought|purchased|registered)/.test(m)) return 'purchase_date';
  if (/total (asset )?value|net worth|how much (is|are) (my|all)|overall value|portfolio value|worth (of|are)/.test(m)) return 'total_value';
  if (/how many assets|total assets|count of assets|number of assets/.test(m)) return 'count_assets';
  if (/most expensive|priciest|highest value/.test(m)) return 'most_expensive';
  if (/(cheapest|least expensive|lowest value)/.test(m)) return 'least_expensive';
  if (/oldest|first (asset|thing) i added|earliest purchase/.test(m)) return 'oldest_asset';
  if (/newest|latest|most recent(ly)?|last added/.test(m)) return 'newest_asset';
  if (/service (record|history)|maintenance (record|history)|serviced/.test(m)) return 'service_history';
  if (/(list|show|display).*(all|every)?.*assets?|what (assets|things) do i have|inventory/.test(m)) return 'list_all';
  if (/breakdown|by category|categories/.test(m)) return 'category_breakdown';
  if (/document(s)? (for|of|attached)/.test(m)) return 'documents_for_asset';
  return 'asset_lookup';
}
function listAssetLines(assets, formatter) {
  return assets.map(formatter).join('\n');
}
function generateReply(message, assets) {
  const intent = detectIntent(message);
  const now = new Date();
  if (assets.length === 0 && !['greeting', 'help'].includes(intent)) {
    return "You don't have any assets saved in your vault yet. Once you scan or add a receipt, I can answer questions about it.";
  }
  switch (intent) {
    case 'greeting':
      return "Hi! I'm Kaagazaad AI. Ask me things like \"which warranties expire soon\", \"show purchases above ₹50,000\", or \"when did I buy my MacBook?\"";
    case 'help':
      return "I can help you with:\n• Warranty expiry (\"which warranties expire soon\")\n• Value filters (\"purchases above ₹50,000\")\n• Purchase dates (\"when did I buy my iPhone\")\n• Totals (\"what's my total asset value\")\n• Service history (\"service records for my car\")\n• Finding a specific item (\"tell me about my MacBook\")";
    case 'warranty_expiring': {
      const windowDays = extractWindowDays(message);
      const upcoming = assets
        .filter(a => a.expiryDate)
        .map(a => ({ a, days: daysBetween(now, new Date(a.expiryDate)) }))
        .filter(x => x.days >= 0 && x.days <= windowDays)
        .sort((x, y) => x.days - y.days);
      if (upcoming.length === 0) {
        return `No warranties are expiring within the next ${windowDays} days. ✅`;
      }
      const lines = upcoming.map(x => `• ${x.a.name} — expires ${formatDate(x.a.expiryDate)} (in ${x.days} day${x.days === 1 ? '' : 's'})`).join('\n');
      return `${upcoming.length} warrant${upcoming.length === 1 ? 'y is' : 'ies are'} expiring within ${windowDays} days:\n${lines}`;
    }
    case 'warranty_expired': {
      const expired = assets
        .filter(a => a.expiryDate && new Date(a.expiryDate) < now)
        .sort((a, b) => new Date(b.expiryDate) - new Date(a.expiryDate));
      if (expired.length === 0) return "None of your asset warranties have expired. 🎉";
      const lines = expired.map(a => `• ${a.name} — expired ${formatDate(a.expiryDate)}`).join('\n');
      return `${expired.length} warrant${expired.length === 1 ? 'y has' : 'ies have'} expired:\n${lines}`;
    }
    case 'price_above': {
      const amount = parseAmount(message);
      if (amount == null) return "Tell me an amount, e.g. \"show purchases above ₹50,000\".";
      const matches = assets.filter(a => (a.valueAmount || 0) > amount).sort((a, b) => (b.valueAmount || 0) - (a.valueAmount || 0));
      if (matches.length === 0) return `No assets found above ${formatINR(amount)}.`;
      return `${matches.length} asset${matches.length === 1 ? '' : 's'} above ${formatINR(amount)}:\n` + listAssetLines(matches, a => `• ${a.name} — ${formatINR(a.valueAmount || 0)}`);
    }
    case 'price_below': {
      const amount = parseAmount(message);
      if (amount == null) return "Tell me an amount, e.g. \"show purchases under ₹10,000\".";
      const matches = assets.filter(a => (a.valueAmount || 0) < amount && (a.valueAmount || 0) > 0).sort((a, b) => (a.valueAmount || 0) - (b.valueAmount || 0));
      if (matches.length === 0) return `No assets found under ${formatINR(amount)}.`;
      return `${matches.length} asset${matches.length === 1 ? '' : 's'} under ${formatINR(amount)}:\n` + listAssetLines(matches, a => `• ${a.name} — ${formatINR(a.valueAmount || 0)}`);
    }
    case 'price_between': {
      const nums = (message.match(/₹?\s?\d[\d,]*(\.\d+)?\s?(k|l|lakh|lac|cr|crore)?/gi) || []).map(s => parseAmount(s));
      if (nums.length < 2) return "Give me a range, e.g. \"between ₹10,000 and ₹50,000\".";
      const [lo, hi] = [Math.min(nums[0], nums[1]), Math.max(nums[0], nums[1])];
      const matches = assets.filter(a => (a.valueAmount || 0) >= lo && (a.valueAmount || 0) <= hi).sort((a, b) => (a.valueAmount || 0) - (b.valueAmount || 0));
      if (matches.length === 0) return `No assets found between ${formatINR(lo)} and ${formatINR(hi)}.`;
      return `${matches.length} asset${matches.length === 1 ? '' : 's'} between ${formatINR(lo)} and ${formatINR(hi)}:\n` + listAssetLines(matches, a => `• ${a.name} — ${formatINR(a.valueAmount || 0)}`);
    }
    case 'purchase_date': {
      const phrase = extractSearchPhrase(message);
      const matches = findMatchingAssets(phrase, assets, 3);
      if (matches.length === 0) return "I couldn't find that asset in your vault. Could you check the name?";
      if (matches.length === 1) {
        const a = matches[0];
        return a.issueDate ? `You bought/registered ${a.name} on ${formatDate(a.issueDate)}.` : `I don't have a purchase date recorded for ${a.name}.`;
      }
      return `Found a few matches:\n` + listAssetLines(matches, a => `• ${a.name} — ${a.issueDate ? formatDate(a.issueDate) : 'no date on file'}`);
    }
    case 'total_value': {
      const total = assets.reduce((sum, a) => sum + (Number(a.valueAmount) || 0), 0);
      return `Your ${assets.length} asset${assets.length === 1 ? '' : 's'} are together worth ${formatINR(total)}.`;
    }
    case 'count_assets': {
      const byCategory = {};
      assets.forEach(a => { byCategory[a.category] = (byCategory[a.category] || 0) + 1; });
      const breakdown = Object.entries(byCategory).map(([cat, n]) => `${cat}: ${n}`).join(', ');
      return `You have ${assets.length} asset${assets.length === 1 ? '' : 's'} total (${breakdown}).`;
    }
    case 'most_expensive': {
      const top = [...assets].sort((a, b) => (b.valueAmount || 0) - (a.valueAmount || 0))[0];
      return `Your most valuable asset is ${top.name} at ${formatINR(top.valueAmount || 0)}.`;
    }
    case 'least_expensive': {
      const withValue = assets.filter(a => (a.valueAmount || 0) > 0);
      if (withValue.length === 0) return "None of your assets have a recorded value.";
      const bottom = [...withValue].sort((a, b) => (a.valueAmount || 0) - (b.valueAmount || 0))[0];
      return `Your least expensive recorded asset is ${bottom.name} at ${formatINR(bottom.valueAmount || 0)}.`;
    }
    case 'oldest_asset': {
      const withDate = assets.filter(a => a.issueDate);
      if (withDate.length === 0) return "None of your assets have a purchase date recorded.";
      const oldest = [...withDate].sort((a, b) => new Date(a.issueDate) - new Date(b.issueDate))[0];
      return `Your oldest recorded asset is ${oldest.name}, purchased on ${formatDate(oldest.issueDate)}.`;
    }
    case 'newest_asset': {
      const newest = [...assets].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
      return `Your most recently added asset is ${newest.name}${newest.issueDate ? `, purchased on ${formatDate(newest.issueDate)}` : ''}.`;
    }
    case 'service_history': {
      const phrase = extractSearchPhrase(message);
      const matches = findMatchingAssets(phrase, assets, 3);
      const target = matches.length > 0 ? matches : assets.filter(a => (a.serviceRecords || []).length > 0);
      const withRecords = target.filter(a => (a.serviceRecords || []).length > 0);
      if (withRecords.length === 0) return "No service records found for that.";
      return withRecords.map(a => {
        const lines = a.serviceRecords.map(r => `  - ${r.title} on ${formatDate(r.date)} (${formatINR(r.cost)})`).join('\n');
        return `${a.name}:\n${lines}`;
      }).join('\n\n');
    }
    case 'list_all': {
      const sorted = [...assets].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return `You have ${sorted.length} asset${sorted.length === 1 ? '' : 's'}:\n` + listAssetLines(sorted, a => `• ${a.name} (${a.category}) — ${formatINR(a.valueAmount || 0)}`);
    }
    case 'category_breakdown': {
      const byCategory = {};
      assets.forEach(a => {
        byCategory[a.category] = byCategory[a.category] || { count: 0, value: 0 };
        byCategory[a.category].count += 1;
        byCategory[a.category].value += Number(a.valueAmount) || 0;
      });
      return Object.entries(byCategory).map(([cat, d]) => `• ${cat}: ${d.count} item${d.count === 1 ? '' : 's'}, ${formatINR(d.value)}`).join('\n');
    }
    case 'documents_for_asset': {
      const phrase = extractSearchPhrase(message);
      const matches = findMatchingAssets(phrase, assets, 1);
      if (matches.length === 0) return "I couldn't find that asset.";
      const a = matches[0];
      const count = (a.documents || []).length;
      return count === 0 ? `No documents are attached to ${a.name}.` : `${a.name} has ${count} document${count === 1 ? '' : 's'} attached.`;
    }
    case 'asset_lookup':
    default: {
      const phrase = extractSearchPhrase(message);
      const matches = findMatchingAssets(phrase, assets, 3);
      if (matches.length === 0) {
        return "I'm not sure about that. Try asking about warranties, purchase dates, values, or a specific item by name.";
      }
      if (matches.length === 1) {
        return generateAssetSummary(matches[0]);
      }
      return `Found a few matches:\n` + listAssetLines(matches, a => `• ${a.name} — ${a.category}, ${formatINR(a.valueAmount || 0)}`);
    }
  }
}
function generateAssetSummary(asset) {
  const sentences = [];
  const name = asset.name || 'This asset';
  const brand = asset.brandOrDeveloper && asset.brandOrDeveloper !== '-' ? asset.brandOrDeveloper : null;
  const seller = asset.storeOrSeller && asset.storeOrSeller !== '-' ? asset.storeOrSeller : null;
  const category = asset.category || null;
  let overview = `${name}`;
  if (brand) overview += ` from ${brand}`;
  if (category) overview += ` is registered under your ${category}${asset.subCategory ? ` / ${asset.subCategory}` : ''} vault`;
  else overview += ' is stored in your vault';
  if (asset.issueDate) overview += `, purchased${seller ? ` from ${seller}` : ''} on ${formatDate(asset.issueDate)}`;
  else if (seller) overview += `, purchased from ${seller}`;
  overview += '.';
  sentences.push(overview);
  if (asset.valueAmount) {
    sentences.push(`It was valued at ${formatINR(asset.valueAmount)}${asset.invoiceNumber && asset.invoiceNumber !== '-' ? `, recorded under invoice/deed number ${asset.invoiceNumber}` : ''}.`);
  }
  if (asset.expiryDate) {
    const days = daysBetween(new Date(), new Date(asset.expiryDate));
    if (days >= 0) {
      sentences.push(`Its warranty is currently active and valid until ${formatDate(asset.expiryDate)}${days <= 60 ? ` (expiring in ${days} day${days === 1 ? '' : 's'})` : ''}.`);
    } else {
      sentences.push(`Its warranty expired on ${formatDate(asset.expiryDate)}, ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago.`);
    }
  }
  const records = asset.serviceRecords || [];
  if (records.length > 0) {
    const latest = [...records].sort((a, b) => new Date(b.date) - new Date(a.date))[0];
    const totalCost = records.reduce((s, r) => s + (r.cost || 0), 0);
    sentences.push(`It has ${records.length} service record${records.length === 1 ? '' : 's'} on file totaling ${formatINR(totalCost)}, most recently "${latest.title}" on ${formatDate(latest.date)}.`);
  }
  const docCount = (asset.documents || []).length;
  if (docCount > 0) {
    sentences.push(`${docCount} supporting document${docCount === 1 ? ' is' : 's are'} securely stored with this record.`);
  }
  return sentences.join(' ');
}
function formatDateFlexible(value) {
  if (!value || value === '-') return null;
  const formatted = formatDate(value);
  if (formatted) return formatted;
  return String(value);
}
function generateWarrantyClaimEmail(asset, user) {
  const name = asset.name || 'the item';
  const seller = asset.storeOrSeller && asset.storeOrSeller !== '-' ? asset.storeOrSeller : null;
  const issuer = asset.issuingAuthority && asset.issuingAuthority !== '-' ? asset.issuingAuthority : null;
  const refNumber = (asset.invoiceNumber && asset.invoiceNumber !== '-' ? asset.invoiceNumber : null)
    || (asset.documentNumber && asset.documentNumber !== '-' ? asset.documentNumber : null);
  const purchaseDate = formatDateFlexible(asset.issueDate);
  const expiryDate = formatDateFlexible(asset.expiryDate);
  const value = asset.valueAmount && asset.valueAmount !== '-' ? asset.valueAmount : null;
  const parsedValue = value != null ? parseAmount(String(value)) : null;
  let warrantyStatusLine;
  if (expiryDate) {
    const parsedExpiry = new Date(asset.expiryDate);
    const isValidDate = !isNaN(parsedExpiry.getTime());
    const daysLeft = isValidDate ? daysBetween(new Date(), parsedExpiry) : null;
    if (daysLeft != null && daysLeft >= 0) {
      warrantyStatusLine = `The item is still within its warranty period, valid until ${expiryDate}.`;
    } else if (daysLeft != null) {
      warrantyStatusLine = `I understand the standard warranty period ended on ${expiryDate}; however, I would still like to request your assistance in resolving this issue under any applicable service or goodwill policy.`;
    } else {
      warrantyStatusLine = `The warranty on record is noted as valid until ${expiryDate}.`;
    }
  } else {
    warrantyStatusLine = 'This item is registered in my records as being under warranty.';
  }
  const subjectRef = refNumber ? ` (Ref: ${refNumber})` : '';
  const subject = `Warranty Claim Request – ${name}${subjectRef}`;
  const greetingTarget = seller || issuer || 'Customer Support / Warranty Team';
  const detailLines = [];
  detailLines.push(`- Product/Item Name: ${name}`);
  if (asset.category) detailLines.push(`- Category: ${asset.category}${asset.subCategory ? ` / ${asset.subCategory}` : ''}`);
  if (refNumber) detailLines.push(`- Invoice/Document Number: ${refNumber}`);
  if (purchaseDate) detailLines.push(`- Purchase Date: ${purchaseDate}`);
  if (expiryDate) detailLines.push(`- Warranty Valid Until: ${expiryDate}`);
  if (issuer) detailLines.push(`- Issuing Authority/Brand: ${issuer}`);
  if (parsedValue) detailLines.push(`- Purchase Value: ${formatINR(parsedValue)}`);
  const userName = (user && user.fullName) || 'Customer';
  const userEmail = (user && user.email) || '';
  const userPhone = (user && user.phone) || '';
  const bodyParts = [];
  bodyParts.push(`To,\n${greetingTarget}`);
  bodyParts.push('Subject: ' + subject);
  bodyParts.push(
    `Dear Sir/Madam,\n\nI am writing to raise a warranty claim for my ${name}${seller ? `, purchased from ${seller}` : ''}${purchaseDate ? ` on ${purchaseDate}` : ''}. ${warrantyStatusLine}`
  );
  bodyParts.push(`Item / claim details:\n${detailLines.join('\n')}`);
  bodyParts.push(
    '[Please describe the issue you are facing with the item here — e.g. the defect, when it started, and any troubleshooting already attempted.]'
  );
  bodyParts.push(
    `I would request you to kindly arrange for a repair, replacement, or servicing of the item at the earliest, in accordance with the applicable warranty terms. The purchase invoice and other supporting documents are available with me and can be shared if required.`
  );
  bodyParts.push('Please let me know if any further information is needed to process this claim.');
  bodyParts.push(
    `Regards,\n${userName}${userEmail ? `\n${userEmail}` : ''}${userPhone ? `\n${userPhone}` : ''}`
  );
  const body = bodyParts.join('\n\n');
  return { subject, body };
}
module.exports = {
  formatINR,
  parseAmount,
  extractWindowDays,
  findMatchingAssets,
  detectIntent,
  generateReply,
  generateAssetSummary,
  generateWarrantyClaimEmail,
};
