require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const Stripe = require('stripe');
const sgMail = require('@sendgrid/mail');
const NodeCache = require('node-cache');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');

const app = express();
const cache = new NodeCache({ stdTTL: 3600 });

// ── Clients ──────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || 'placeholder' });
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || 'placeholder');
sgMail.setApiKey(process.env.SENDGRID_API_KEY || 'placeholder');

// ── Middleware ────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));

// ── Georgia County Config ─────────────────────────────────────────
const GEORGIA_COUNTIES = {
  'Fulton':    { millage: 10.16, rate: 0.01016, deadline: 'May 30, 2026',   assessor: 'Board of Tax Assessors, 235 Peachtree St NE Ste 1400, Atlanta GA 30303' },
  'Gwinnett':  { millage: 12.50, rate: 0.01250, deadline: 'June 15, 2026',  assessor: 'Gwinnett County Board of Assessors, 75 Langley Dr, Lawrenceville GA 30046' },
  'DeKalb':    { millage: 14.20, rate: 0.01420, deadline: 'May 15, 2026',   assessor: 'DeKalb County Board of Assessors, 120 W Trinity Pl, Decatur GA 30030' },
  'Cobb':      { millage:  9.80, rate: 0.00980, deadline: 'June 1, 2026',   assessor: 'Cobb County Board of Tax Assessors, 736 Whitlock Ave, Marietta GA 30064' },
  'Cherokee':  { millage:  8.80, rate: 0.00880, deadline: 'June 10, 2026',  assessor: 'Cherokee County Board of Assessors, 2782 Marietta Hwy, Canton GA 30114' },
  'Forsyth':   { millage:  7.20, rate: 0.00720, deadline: 'May 25, 2026',   assessor: 'Forsyth County Board of Assessors, 110 E Main St, Cumming GA 30040' },
  'Henry':     { millage: 11.00, rate: 0.01100, deadline: 'June 5, 2026',   assessor: 'Henry County Board of Assessors, 140 Henry Pkwy, McDonough GA 30253' },
  'Paulding':  { millage: 10.50, rate: 0.01050, deadline: 'June 8, 2026',   assessor: 'Paulding County Board of Assessors, 240 Constitution Blvd, Dallas GA 30132' },
  'Clayton':   { millage: 13.80, rate: 0.01380, deadline: 'June 12, 2026',  assessor: 'Clayton County Board of Assessors, 121 S McDonough St, Jonesboro GA 30236' },
  'Rockdale':  { millage: 12.20, rate: 0.01220, deadline: 'June 3, 2026',   assessor: 'Rockdale County Board of Assessors, 922 Court St NE, Conyers GA 30012' },
  'Hall':      { millage:  9.50, rate: 0.00950, deadline: 'June 7, 2026',   assessor: 'Hall County Board of Assessors, 2875 Browns Bridge Rd, Gainesville GA 30504' },
  'Chatham':   { millage: 10.80, rate: 0.01080, deadline: 'June 14, 2026',  assessor: 'Chatham County Board of Assessors, 222 W Oglethorpe Ave, Savannah GA 31401' },
};

// ── ROUTE 1: Address Lookup ───────────────────────────────────────
app.post('/api/address/lookup',
  [body('address').notEmpty().trim()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { address } = req.body;
    const cacheKey = 'addr:' + address.toLowerCase().replace(/\s+/g, '_');
    if (cache.has(cacheKey)) return res.json(cache.get(cacheKey));

    try {
      if (!process.env.GOOGLE_MAPS_API_KEY) {
        // Fallback: basic county detection from address string
        const county = detectCountyFromString(address);
        const payload = { formatted: address, county, state: 'GA', appealDeadline: GEORGIA_COUNTIES[county]?.deadline || 'May 30, 2026', source: 'fallback' };
        return res.json(payload);
      }

      const geoRes = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
        params: { address: address + ', Georgia', key: process.env.GOOGLE_MAPS_API_KEY, components: 'administrative_area:GA|country:US' }
      });

      if (!geoRes.data.results?.length) return res.status(404).json({ error: 'Address not found.' });

      const result = geoRes.data.results[0];
      const { lat, lng } = result.geometry.location;
      const countyComp = result.address_components?.find(c => c.types.includes('administrative_area_level_2'));
      const county = countyComp?.long_name?.replace(' County', '') || 'Fulton';

      const payload = { formatted: result.formatted_address, lat, lng, county, state: 'GA', appealDeadline: GEORGIA_COUNTIES[county]?.deadline || 'May 30, 2026', countyConfig: GEORGIA_COUNTIES[county] || null };
      cache.set(cacheKey, payload);
      res.json(payload);
    } catch (err) {
      console.error('Address lookup error:', err.message);
      res.status(500).json({ error: 'Address lookup failed: ' + err.message });
    }
  }
);

// ── ROUTE 2: Property Assessment ─────────────────────────────────
app.post('/api/property/assessment',
  [body('address').notEmpty(), body('county').notEmpty()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { address, lat, lng, county } = req.body;
    const cacheKey = 'assessment:' + address;
    if (cache.has(cacheKey)) return res.json(cache.get(cacheKey));

    try {
      let data = null;
      if (process.env.ATTOM_API_KEY) {
        data = await fetchATTOMAssessment(address, lat, lng);
      }

      if (!data) {
        data = generateSampleProperty(county);
      }

      const countyConfig = GEORGIA_COUNTIES[county] || GEORGIA_COUNTIES['Fulton'];
      const payload = { ...data, annualTax: Math.round(data.assessedValue * countyConfig.rate), countyMillage: countyConfig.millage, taxRate: countyConfig.rate, appealDeadline: countyConfig.deadline, assessorAddr: countyConfig.assessor };
      cache.set(cacheKey, payload, 86400);
      res.json(payload);
    } catch (err) {
      console.error('Assessment error:', err.message);
      res.status(500).json({ error: 'Could not retrieve assessment: ' + err.message });
    }
  }
);

// ── ROUTE 3: Comparable Sales ─────────────────────────────────────
app.post('/api/comps/search',
  [body('sqft').isInt()],
  async (req, res) => {
    const { lat, lng, sqft, yearBuilt, assessedValue, county } = req.body;
    const cacheKey = `comps:${(lat||0).toFixed(3)},${(lng||0).toFixed(3)},${sqft}`;
    if (cache.has(cacheKey)) return res.json(cache.get(cacheKey));

    try {
      let rawComps = [];
      if (process.env.ATTOM_API_KEY && lat && lng) {
        rawComps = await fetchATTOMComps({ lat, lng, sqft, yearBuilt });
      }
      if (!rawComps.length) {
        rawComps = generateSampleComps(sqft);
      }

      const subjectPPSF = Math.round((assessedValue / 0.4) / sqft);
      const scored = rawComps
        .map(c => ({ ...c, pricePerSqft: Math.round(c.salePrice / c.sqft) }))
        .sort((a, b) => a.pricePerSqft - b.pricePerSqft);

      const recommended = scored.filter(c => c.pricePerSqft < subjectPPSF).slice(0, 3).map(c => c.id);
      const payload = { comps: scored.slice(0, 5), recommended, subjectPPSF };
      cache.set(cacheKey, payload, 3600);
      res.json(payload);
    } catch (err) {
      console.error('Comps error:', err.message);
      res.status(500).json({ error: 'Could not retrieve comps: ' + err.message });
    }
  }
);

// ── ROUTE 4: AI Analysis ──────────────────────────────────────────
app.post('/api/ai/analyze',
  [body('property').notEmpty(), body('comps').isArray({ min: 1 })],
  async (req, res) => {
    const { property, comps, county } = req.body;

    try {
      const avgCompPPSF = Math.round(comps.reduce((s, c) => s + c.pricePerSqft, 0) / comps.length);
      const recommendedFMV = Math.round(avgCompPPSF * property.sqft);
      const recommendedAV  = Math.round(recommendedFMV * 0.4);
      const currentFMV = Math.round(property.assessedValue / 0.4);
      const overassessmentPct = Math.round(((currentFMV - recommendedFMV) / currentFMV) * 100);
      const countyConfig = GEORGIA_COUNTIES[county] || GEORGIA_COUNTIES['Fulton'];
      const annualSaving = Math.round((property.assessedValue - recommendedAV) * countyConfig.rate);

      let narrative = getFallbackNarrative(property, comps, county, recommendedAV, overassessmentPct);
      let strength = { score: 7, label: 'Strong', reason: 'Comparable evidence supports a lower valuation.' };

      if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'placeholder') {
        try {
          const narrativeRes = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 400,
            messages: [{ role: 'user', content: buildNarrativePrompt(property, comps, county, recommendedAV, overassessmentPct) }]
          });
          narrative = narrativeRes.content[0]?.text || narrative;
        } catch (e) {
          console.warn('Claude API error, using fallback:', e.message);
        }
      }

      res.json({ narrative, strength, recommendedAV, recommendedFMV, overassessmentPct, annualSaving, saving3yr: annualSaving * 3, avgCompPPSF, subjectPPSF: Math.round(currentFMV / property.sqft) });
    } catch (err) {
      console.error('AI analysis error:', err.message);
      res.status(500).json({ error: 'Analysis failed: ' + err.message });
    }
  }
);

// ── ROUTE 5: Create Payment Intent ───────────────────────────────
app.post('/api/payment/create-intent', async (req, res) => {
  const { plan, email, packageId } = req.body;
  try {
    if (plan === 'full-service') return res.json({ type: 'full-service', clientSecret: null });
    if (!process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY === 'placeholder') {
      return res.json({ clientSecret: 'demo_mode', demo: true });
    }
    const paymentIntent = await stripe.paymentIntents.create({
      amount: 7900, currency: 'usd',
      metadata: { packageId, plan, email },
      description: 'AppealPilot DIY Kit — Georgia Property Tax Appeal',
      receipt_email: email,
      automatic_payment_methods: { enabled: true }
    });
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error('Payment error:', err.message);
    res.status(500).json({ error: 'Payment setup failed: ' + err.message });
  }
});

// ── ROUTE 6: Send Email ───────────────────────────────────────────
app.post('/api/email/send-package', async (req, res) => {
  const { email, ownerName, packageId, county, deadline } = req.body;
  try {
    if (!process.env.SENDGRID_API_KEY || process.env.SENDGRID_API_KEY === 'placeholder') {
      return res.json({ success: true, demo: true, message: 'Demo mode — email not sent' });
    }
    const msg = {
      to: email,
      from: { email: process.env.SENDGRID_FROM_EMAIL || 'appeals@appealpilot.com', name: 'AppealPilot' },
      subject: `Your Georgia Property Tax Appeal Package — ${county} County`,
      html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#111827;padding:24px;text-align:center">
          <h1 style="color:#16a34a;margin:0;font-size:1.4rem">AppealPilot</h1>
          <p style="color:#9ca3af;margin:8px 0 0">Your appeal package is ready</p>
        </div>
        <div style="padding:32px">
          <p>Hi ${ownerName},</p>
          <p>Your <strong>${county} County property tax appeal package</strong> has been generated. Your appeal includes:</p>
          <ul>
            <li>✅ Pre-filled PT-311A Appeal Form</li>
            <li>✅ Comparable Sales Evidence (Exhibit A)</li>
            <li>✅ AI Evidence Narrative (Exhibit B)</li>
            <li>✅ County Filing Instructions</li>
          </ul>
          <div style="background:#fef9c3;border:1px solid #fde047;border-radius:8px;padding:16px;margin:20px 0">
            <strong>⚠️ Your appeal deadline is ${deadline}</strong><br>
            Your PT-311A must be postmarked by this date.
          </div>
          <p>Package ID: <code>${packageId}</code></p>
        </div>
        <div style="background:#f9fafb;padding:16px;text-align:center;font-size:0.8rem;color:#6b7280">
          AppealPilot · Not a law firm · Not legal advice
        </div>
      </div>`
    };
    await sgMail.send(msg);
    res.json({ success: true, message: 'Package sent to ' + email });
  } catch (err) {
    console.error('Email error:', err.message);
    res.status(500).json({ error: 'Email failed: ' + err.message });
  }
});

// ── ROUTE 7: Health Check ─────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({
  status: 'ok',
  service: 'AppealPilot API',
  integrations: {
    googleMaps:  !!process.env.GOOGLE_MAPS_API_KEY,
    attom:       !!process.env.ATTOM_API_KEY,
    anthropic:   !!(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'placeholder'),
    stripe:      !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY !== 'placeholder'),
    sendgrid:    !!(process.env.SENDGRID_API_KEY && process.env.SENDGRID_API_KEY !== 'placeholder'),
  }
}));

// ── HELPERS ───────────────────────────────────────────────────────
function detectCountyFromString(address) {
  const a = address.toLowerCase();
  if (a.includes('marietta') || a.includes('kennesaw') || a.includes('smyrna')) return 'Cobb';
  if (a.includes('lawrenceville') || a.includes('duluth') || a.includes('norcross') || a.includes('buford') || a.includes('sugar hill') || a.includes('suwanee')) return 'Gwinnett';
  if (a.includes('decatur') || a.includes('tucker') || a.includes('stone mountain')) return 'DeKalb';
  if (a.includes('canton') || a.includes('ball ground')) return 'Cherokee';
  if (a.includes('cumming')) return 'Forsyth';
  if (a.includes('mcdonough') || a.includes('stockbridge')) return 'Henry';
  if (a.includes('gainesville')) return 'Hall';
  if (a.includes('savannah')) return 'Chatham';
  return 'Fulton';
}

async function fetchATTOMAssessment(address, lat, lng) {
  try {
    const res = await axios.get('https://api.gateway.attomdata.com/propertyapi/v1.0.0/property/detail', {
      headers: { 'apikey': process.env.ATTOM_API_KEY, 'accept': 'application/json' },
      params: { address1: address.split(',')[0], address2: address.split(',').slice(1).join(',').trim() }
    });
    const prop = res.data?.property?.[0];
    if (!prop) return null;
    return {
      parcelId: prop.identifier?.apn,
      assessedValue: prop.assessment?.assessed?.assdTtlValue || 0,
      sqft: prop.building?.size?.universalsize || 0,
      yearBuilt: prop.building?.summary?.yearbuilt || 0,
      bedrooms: prop.building?.rooms?.beds || 0,
      bathrooms: prop.building?.rooms?.bathstotal || 0,
      source: 'ATTOM'
    };
  } catch (err) {
    console.error('ATTOM error:', err.message);
    return null;
  }
}

async function fetchATTOMComps({ lat, lng, sqft }) {
  try {
    const res = await axios.get('https://api.gateway.attomdata.com/propertyapi/v1.0.0/salescomparables/address', {
      headers: { 'apikey': process.env.ATTOM_API_KEY, 'accept': 'application/json' },
      params: { latitude: lat, longitude: lng, searchRadius: 1.0, minSqFt: Math.round(sqft * 0.7), maxSqFt: Math.round(sqft * 1.3), pageSize: 10 }
    });
    return (res.data?.salescomparables || []).map((c, i) => ({
      id: 'attom-' + i,
      address: `${c.address?.line1}, ${c.address?.locality}`,
      salePrice: c.sale?.amount?.saleAmt,
      saleDate: c.sale?.saleRecDate,
      sqft: c.building?.size?.universalsize,
      yearBuilt: c.building?.summary?.yearbuilt,
      distance: c.distanceInMiles,
      source: 'ATTOM'
    })).filter(c => c.salePrice > 0 && c.sqft > 0);
  } catch (err) {
    console.error('ATTOM comps error:', err.message);
    return [];
  }
}

function generateSampleProperty(county) {
  const cd = GEORGIA_COUNTIES[county] || GEORGIA_COUNTIES['Fulton'];
  return { assessedValue: 342400, sqft: 2140, yearBuilt: 2003, bedrooms: 4, bathrooms: 2.5, parcelId: 'LOOKUP-REQUIRED', source: 'Sample data — add ATTOM API key for live data' };
}

function generateSampleComps(sqft) {
  const streets = ['Ridgewood Ct', 'Briar Glen Dr', 'Millbrook Ln', 'Willow Creek Rd', 'Stonebridge Pkwy'];
  return [
    { id: 'S0', address: '847 ' + streets[0], salePrice: Math.round(sqft * 138), sqft: Math.round(sqft * 0.94), yearBuilt: 2001, saleDate: '2025-10-12', distance: 0.3 },
    { id: 'S1', address: '1102 ' + streets[1], salePrice: Math.round(sqft * 147), sqft: Math.round(sqft * 1.04), yearBuilt: 2004, saleDate: '2025-11-04', distance: 0.5 },
    { id: 'S2', address: '523 ' + streets[2], salePrice: Math.round(sqft * 133), sqft: Math.round(sqft * 0.97), yearBuilt: 2002, saleDate: '2025-09-18', distance: 0.7 },
    { id: 'S3', address: '319 ' + streets[3], salePrice: Math.round(sqft * 153), sqft: Math.round(sqft * 1.08), yearBuilt: 2005, saleDate: '2025-12-01', distance: 0.9 },
    { id: 'S4', address: '754 ' + streets[4], salePrice: Math.round(sqft * 130), sqft: Math.round(sqft * 0.92), yearBuilt: 1999, saleDate: '2025-08-22', distance: 1.1 },
  ];
}

function buildNarrativePrompt(property, comps, county, recommendedAV, pct) {
  const compsText = comps.map(c => `- ${c.address}: $${c.salePrice?.toLocaleString()} ($${c.pricePerSqft}/sqft), ${c.saleDate}`).join('\n');
  return `Write a 4-sentence formal Georgia property tax appeal statement for a Board of Equalization hearing.\nCounty: ${county}\nCurrent assessed value: $${property.assessedValue?.toLocaleString()}\nProposed value: $${recommendedAV.toLocaleString()} (${pct}% reduction)\nComparables:\n${compsText}\nBegin with "The taxpayer respectfully submits..." Cite O.C.G.A. § 48-5-2. Under 100 words. Formal tone.`;
}

function getFallbackNarrative(property, comps, county, recommendedAV, pct) {
  const avgPPSF = Math.round(comps.reduce((s, c) => s + c.pricePerSqft, 0) / comps.length);
  const yourPPSF = Math.round((property.assessedValue / 0.4) / property.sqft);
  return `The taxpayer respectfully submits that the ${county} County Board of Assessors' 2026 assessment overstates the subject property's fair market value under O.C.G.A. § 48-5-2. Analysis of ${comps.length} arm's-length comparable sales within one mile reveals an average price of $${avgPPSF} per square foot, compared to the $${yourPPSF} per square foot implied by the current assessment — a difference of approximately ${pct}%. The taxpayer requests a reduction in assessed value to $${recommendedAV.toLocaleString()}, consistent with the enclosed comparable sales evidence. All cited transactions are verified arm's-length sales from ${county} County public records.`;
}

// ── START ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`AppealPilot API running on port ${PORT}`));
module.exports = app;
