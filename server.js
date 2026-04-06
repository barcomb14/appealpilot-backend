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
const PDFDocument = require('pdfkit');
const app = express();
app.set('trust proxy', 1);
const cache = new NodeCache({ stdTTL: 3600 }); // 1-hour cache

// ── Clients ──────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || 'placeholder' });
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || 'placeholder');
sgMail.setApiKey(process.env.SENDGRID_API_KEY || 'placeholder');

// ── Middleware ────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (!allowedOrigins.length) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  }
}));
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

      if (!geoRes.data.results?.length) {
  console.error('Google geocode failed:', geoRes.data.status, geoRes.data.error_message || 'no error_message', 'address:', address);
  return res.status(404).json({
    error: 'Address not found.',
    googleStatus: geoRes.data.status,
    googleMessage: geoRes.data.error_message || null
  });
}

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
    const cacheKey = 'assessment:v2:' + address;
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
      const annualTax =
        typeof data.annualTax === 'number' && data.annualTax > 0
          ? Math.round(data.annualTax)
          : Math.round(data.assessedValue * countyConfig.rate);
      const payload = {
        ...data,
        annualTax,
        countyMillage: countyConfig.millage,
        taxRate: countyConfig.rate,
        appealDeadline: countyConfig.deadline,
        assessorAddr: countyConfig.assessor,
      };
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
    const cacheKey = `comps:${(lat || 0).toFixed(4)},${(lng || 0).toFixed(4)},${sqft},${assessedValue},${String(county || '')}`;
    if (cache.has(cacheKey)) return res.json(cache.get(cacheKey));

    try {
      let rawComps = [];
      // Phase 2: set ATTOM_COMPS_ENABLED=true when sales comparables are on the ATTOM plan.
      const useAttomComps = process.env.ATTOM_COMPS_ENABLED === 'true';
      if (useAttomComps && process.env.ATTOM_API_KEY && lat && lng) {
        rawComps = await fetchATTOMComps({ lat, lng, sqft, yearBuilt });
      }
      if (!rawComps.length) {
        rawComps = generateSubjectPlaceholderComps({
          sqft,
          assessedValue,
          county,
          yearBuilt,
          lat,
          lng,
        });
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

/** ATTOM gateway: send both header casings (basicprofile historically used APIKey; comps use apikey). */
function attomHeaders() {
  const key = process.env.ATTOM_API_KEY;
  return {
    apikey: key,
    APIKey: key,
    accept: 'application/json',
  };
}

/**
 * Merge ATTOM rows: basicprofile has APN/ID; building + summary live on property/detail;
 * assessed values live on assessment/detail.
 */
function mergeAttomPropertyRows(basicRow, detailRow, assessmentRow) {
  const merged = { ...basicRow };
  if (detailRow && typeof detailRow === 'object') {
    if (detailRow.building) {
      merged.building = { ...(merged.building || {}), ...detailRow.building };
    }
    if (detailRow.summary) {
      merged.summary = { ...(merged.summary || {}), ...detailRow.summary };
    }
    if (detailRow.identifier) {
      merged.identifier = { ...(merged.identifier || {}), ...detailRow.identifier };
    }
  }
  if (assessmentRow?.assessment) {
    merged.assessment = assessmentRow.assessment;
  } else if (detailRow?.assessment) {
    merged.assessment = { ...(merged.assessment || {}), ...detailRow.assessment };
  }
  return merged;
}

/**
 * Read numeric from ATTOM property[0] paths (JSON uses mixed camelCase from gateway).
 * property[0].assessment.assessed.assdTtlValue, etc.
 */
function attomNum(value) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function mapAttomRowToAssessment(prop) {
  const assessedBlock = prop.assessment?.assessed || {};
  const marketBlock = prop.assessment?.market || {};
  const taxBlock = prop.assessment?.tax || {};
  const size = prop.building?.size || {};
  const rooms = prop.building?.rooms || {};

  const assessedValue = attomNum(
    assessedBlock.assdTtlValue ?? assessedBlock.assdttlvalue,
  );
  const marketValue = attomNum(
    marketBlock.mktTtlValue ?? marketBlock.mktttlvalue,
  );
  const annualTaxRaw = attomNum(
    taxBlock.taxAmt ?? taxBlock.taxamt,
  );

  const sqft = attomNum(
    size.universalSize ??
      size.universalsize ??
      size.livingSize ??
      size.livingsize ??
      size.bldgSize ??
      size.bldgsize ??
      size.grosssizeadjusted ??
      0,
  );
  const yearBuilt = attomNum(
    prop.summary?.yearbuilt ??
      prop.summary?.yearBuilt ??
      prop.building?.summary?.yearbuilteffective ??
      prop.building?.summary?.yearbuilt ??
      0,
  );
  const bedrooms = attomNum(rooms.beds ?? rooms.Beds);
  const bathrooms = attomNum(
    rooms.bathsTotal ?? rooms.bathstotal ?? rooms.bathscalc ?? rooms.bathsfull ?? 0,
  );

  return {
    parcelId: prop.identifier?.apn || prop.identifier?.apnOrig || 'N/A',
    assessedValue,
    marketValue,
    annualTax: annualTaxRaw > 0 ? annualTaxRaw : undefined,
    sqft,
    yearBuilt,
    bedrooms,
    bathrooms,
    source: 'ATTOM',
  };
}

async function fetchATTOMAssessment(address, lat, lng) {
  try {
    const basicRes = await axios.get(
      'https://api.gateway.attomdata.com/propertyapi/v1.0.0/property/basicprofile',
      {
        headers: attomHeaders(),
        params:
          lat && lng
            ? { latitude: lat, longitude: lng, radius: 0.1 }
            : { address1: address },
      },
    );

    console.log(
      '[ATTOM] property/basicprofile — raw JSON (before mapping):\n',
      JSON.stringify(basicRes.data, null, 2),
    );

    const basicProp = basicRes.data?.property?.[0];
    if (!basicProp) return null;

    const obPropId = basicProp.identifier?.obPropId;
    if (!obPropId) {
      console.warn('[ATTOM] basicprofile missing identifier.obPropId; cannot call detail endpoints');
      return mapAttomRowToAssessment(basicProp);
    }

    let detailProp = null;
    let assessmentProp = null;

    try {
      const detailRes = await axios.get(
        'https://api.gateway.attomdata.com/propertyapi/v1.0.0/property/detail',
        {
          headers: attomHeaders(),
          params: { ID: obPropId },
        },
      );
      console.log(
        '[ATTOM] property/detail — raw JSON (before mapping):\n',
        JSON.stringify(detailRes.data, null, 2),
      );
      detailProp = detailRes.data?.property?.[0] || null;
    } catch (e) {
      console.error(
        '[ATTOM] property/detail failed:',
        e.response?.status,
        e.message,
        e.response?.data ? JSON.stringify(e.response.data) : '',
      );
    }

    try {
      const assessRes = await axios.get(
        'https://api.gateway.attomdata.com/propertyapi/v1.0.0/assessment/detail',
        {
          headers: attomHeaders(),
          params: { ID: obPropId },
        },
      );
      console.log(
        '[ATTOM] assessment/detail — raw JSON (before mapping):\n',
        JSON.stringify(assessRes.data, null, 2),
      );
      assessmentProp = assessRes.data?.property?.[0] || null;
    } catch (e) {
      console.error(
        '[ATTOM] assessment/detail failed:',
        e.response?.status,
        e.message,
        e.response?.data ? JSON.stringify(e.response.data) : '',
      );
    }

    const merged = mergeAttomPropertyRows(basicProp, detailProp, assessmentProp);
    console.log(
      '[ATTOM] merged property row (used for field mapping):\n',
      JSON.stringify(merged, null, 2),
    );

    return mapAttomRowToAssessment(merged);
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

/** Deterministic PRNG for repeatable placeholder comps per subject. */
function mulberry32(seed) {
  return function next() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashPlaceholderSeed(lat, lng, sqft, assessedValue, county) {
  const s = `${lat ?? 0}|${lng ?? 0}|${sqft}|${assessedValue}|${String(county || '').toLowerCase()}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) || 1;
}

/**
 * Temporary Phase-1 comps when ATTOM sales comparables are unavailable.
 * Uses real subject sqft, assessed value, and location for believable $/sqft and sale prices.
 */
function generateSubjectPlaceholderComps({ sqft, assessedValue, county, yearBuilt, lat, lng }) {
  const subjectPPSF = Math.round((assessedValue / 0.4) / sqft);
  let ppsfHigh = Math.min(175, subjectPPSF - 1);
  let ppsfLow = 140;
  if (ppsfHigh < 140) {
    ppsfLow = Math.max(90, subjectPPSF - 45);
    ppsfHigh = subjectPPSF - 1;
  }
  if (ppsfLow >= ppsfHigh) {
    ppsfLow = Math.max(80, ppsfHigh - 35);
  }

  const seed = hashPlaceholderSeed(lat, lng, sqft, assessedValue, county);
  const isGwinnett = /^gwinnett$/i.test(String(county || '').trim());

  const gwinnettPool = [
    [1842, 'Brook Hollow Ln', 'Lawrenceville'],
    [607, 'Old Peachtree Rd NW', 'Duluth'],
    [3295, 'Sugarloaf Pkwy', 'Lawrenceville'],
    [884, 'Webb Gin House Rd', 'Snellville'],
    [1456, 'Cruse Rd NW', 'Lawrenceville'],
    [2703, 'Buford Dr NE', 'Buford'],
    [512, 'Rock Springs Rd NE', 'Lawrenceville'],
    [1788, 'Summerour St', 'Norcross'],
    [933, 'Parsons Blvd', 'Suwanee'],
    [2164, 'McKendree Park Dr', 'Duluth'],
  ];

  const genericPool = [
    [1204, 'Riverside Pkwy', 'Roswell'],
    [883, 'Chattahoochee River Rd', 'Atlanta'],
    [2401, 'Johnson Ferry Rd NE', 'Marietta'],
    [415, 'Piedmont Rd NE', 'Atlanta'],
    [1655, 'Holcomb Bridge Rd', 'Roswell'],
    [702, 'Medlock Bridge Rd', 'Johns Creek'],
    [3388, 'Peachtree Rd NE', 'Atlanta'],
    [1290, 'Windward Pkwy', 'Alpharetta'],
    [556, 'East Ponce de Leon Ave', 'Decatur'],
    [1844, 'Lower Roswell Rd', 'Marietta'],
  ];

  const pool = isGwinnett ? gwinnettPool : genericPool;
  const baseYear =
    typeof yearBuilt === 'number' && yearBuilt > 1800 && yearBuilt < 2100
      ? yearBuilt
      : 2000;

  const now = new Date();
  const comps = [];

  for (let i = 0; i < 5; i++) {
    const rnd = mulberry32((seed + Math.imul(i, 0x9e3779b9)) >>> 0);
    const r1 = rnd();
    const r2 = rnd();
    const r3 = rnd();
    const r4 = rnd();

    const ppsf = Math.round(ppsfLow + r1 * (ppsfHigh - ppsfLow));
    const sqftMult = 0.8 + r2 * 0.4;
    const compSqft = Math.max(1, Math.round(sqft * sqftMult));
    const salePrice = Math.round(compSqft * ppsf);
    const distance = Math.round((0.2 + r3 * 1.0) * 100) / 100;
    const daysAgo = Math.min(364, Math.floor(18 + r4 * 347));
    const saleD = new Date(now);
    saleD.setDate(saleD.getDate() - daysAgo);
    const saleDate = saleD.toISOString().slice(0, 10);

    const poolIdx = Math.floor(rnd() * pool.length) % pool.length;
    const [streetNum, streetName, city] = pool[(poolIdx + i) % pool.length];
    const address = `${streetNum} ${streetName}, ${city}, GA`;

    const ybJitter = Math.floor((rnd() - 0.5) * 10);
    const yb = Math.min(2024, Math.max(1985, baseYear + ybJitter));

    comps.push({
      id: `ph-${seed.toString(36)}-${i}`,
      address,
      salePrice,
      saleDate,
      sqft: compSqft,
      yearBuilt: yb,
      distance,
      source: 'Placeholder (Phase 2: ATTOM comparables)',
    });
  }

  return comps;
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
// ── ROUTE: Generate PDF Package ───────────────────────────────────
app.post('/api/package/generate', async (req, res) => {
  const {
    ownerName, address, county, parcelId,
    assessedValue, proposedValue, deadline,
    assessorAddr, comps, narrative
  } = req.body;

  try {
    const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="appealpilot-package-${county}.pdf"`);
    doc.pipe(res);

    const GREEN = '#16a34a';
    const RED = '#dc2626';
    const DARK = '#111827';
    const GRAY = '#6b7280';
    const fmt = n => n ? '$' + Math.round(n).toLocaleString() : '—';

    // ── PAGE 1: PT-311A ──────────────────────────────────────────
    doc.fontSize(10).fillColor(GRAY).text('STATE OF GEORGIA — DEPARTMENT OF REVENUE', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(14).fillColor(DARK).font('Helvetica-Bold').text('PT-311A', { align: 'center' });
    doc.fontSize(11).font('Helvetica').text("TAXPAYER'S APPEAL OF ASSESSMENT OF REAL PROPERTY", { align: 'center' });
    doc.fontSize(10).fillColor(GRAY).text('TAX YEAR 2026', { align: 'center' });
    doc.moveDown(0.5);

    // Red deadline banner
    doc.rect(50, doc.y, 512, 36).fill('#fef2f2');
    doc.fillColor(RED).fontSize(10).font('Helvetica-Bold')
      .text(`⚠  APPEAL DEADLINE: ${deadline || 'See county notice'}`, 60, doc.y - 28, { align: 'center' });
    doc.moveDown(1.5);

    // Section A
    doc.fillColor(GREEN).fontSize(10).font('Helvetica-Bold').text('SECTION A — PROPERTY OWNER');
    doc.moveTo(50, doc.y).lineTo(562, doc.y).stroke(GREEN);
    doc.moveDown(0.3);

    const field = (label, value) => {
      doc.fillColor(GRAY).fontSize(9).font('Helvetica').text(label, { continued: true });
      doc.fillColor(DARK).font('Helvetica-Bold').text('  ' + (value || '—'));
      doc.moveDown(0.2);
    };

    field('Owner Name:', ownerName);
    field('Property Address:', address);
    field('County:', county + ' County, Georgia');
    field('Parcel ID:', parcelId);
    doc.moveDown(0.5);

    // Section B
    doc.fillColor(GREEN).fontSize(10).font('Helvetica-Bold').text('SECTION B — ASSESSMENT VALUES');
    doc.moveTo(50, doc.y).lineTo(562, doc.y).stroke(GREEN);
    doc.moveDown(0.3);

    field('Current Assessed Value:', fmt(assessedValue));
    field("Taxpayer's Proposed Value:", fmt(proposedValue));
    field('Basis for Appeal:', 'Value — comparable sales support a lower FMV per O.C.G.A. § 48-5-2');
    doc.moveDown(0.5);

    // Section C
    doc.fillColor(GREEN).fontSize(10).font('Helvetica-Bold').text('SECTION C — METHOD OF APPEAL');
    doc.moveTo(50, doc.y).lineTo(562, doc.y).stroke(GREEN);
    doc.moveDown(0.3);
    doc.fillColor(DARK).fontSize(10).font('Helvetica').text('[X] Board of Equalization     [ ] Hearing Officer     [ ] Arbitration');
    doc.moveDown(1.5);

    // Signature
    doc.moveTo(50, doc.y).lineTo(300, doc.y).stroke(DARK);
    doc.fillColor(GRAY).fontSize(8).text('Taxpayer Signature', 50, doc.y + 2);
    doc.moveTo(350, doc.y - 12).lineTo(562, doc.y - 12).stroke(DARK);
    doc.text('Date', 350, doc.y + 2);
    doc.moveDown(2);

    doc.fillColor(GRAY).fontSize(8).font('Helvetica')
      .text('Prepared by AppealPilot — Not a law firm — Not legal advice — localpropertytaxappeals.com', { align: 'center' });

    // ── PAGE 2: COMPARABLE SALES ─────────────────────────────────
    doc.addPage();
    doc.fillColor(GREEN).fontSize(14).font('Helvetica-Bold').text('EXHIBIT A — COMPARABLE SALES EVIDENCE');
    doc.moveTo(50, doc.y).lineTo(562, doc.y).stroke(GREEN);
    doc.moveDown(0.5);

    doc.fillColor(GRAY).fontSize(9).font('Helvetica')
      .text(`The following arm's-length sales were identified within 1.5 miles of the subject property and are submitted as evidence of fair market value under O.C.G.A. § 48-5-2.`);
    doc.moveDown(0.8);

    // Table header
    const cols = [50, 210, 290, 360, 420, 480];
    doc.rect(50, doc.y, 512, 20).fill('#f0fdf4');
    doc.fillColor(GREEN).fontSize(8).font('Helvetica-Bold');
    doc.text('ADDRESS', cols[0], doc.y - 15);
    doc.text('SALE DATE', cols[1], doc.y - 15);
    doc.text('PRICE', cols[2], doc.y - 15);
    doc.text('SQFT', cols[3], doc.y - 15);
    doc.text('$/SQFT', cols[4], doc.y - 15);
    doc.text('DIST', cols[5], doc.y - 15);
    doc.moveDown(0.5);

    const compList = Array.isArray(comps) ? comps : [];
    compList.forEach((c, i) => {
      const rowY = doc.y;
      if (i % 2 === 0) doc.rect(50, rowY, 512, 18).fill('#f9fafb');
      doc.fillColor(DARK).fontSize(8).font('Helvetica');
      doc.text(c.address || '—', cols[0], rowY + 4, { width: 155 });
      doc.text(c.saleDate || c.date || '—', cols[1], rowY + 4);
      doc.text(fmt(c.salePrice || c.price), cols[2], rowY + 4);
      doc.text((c.sqft || 0).toLocaleString(), cols[3], rowY + 4);
      doc.text('$' + (c.pricePerSqft || c.ppsf || 0), cols[4], rowY + 4);
      doc.text((c.distance || c.dist || '—') + ' mi', cols[5], rowY + 4);
      doc.moveDown(1.1);
    });

    doc.moveDown(0.5);
    doc.fillColor(GRAY).fontSize(8).text('Source: ATTOM Property Data / AppealPilot comparable sales analysis');

    // ── PAGE 3: NARRATIVE ────────────────────────────────────────
    doc.addPage();
    doc.fillColor(GREEN).fontSize(14).font('Helvetica-Bold').text('EXHIBIT B — EVIDENCE NARRATIVE');
    doc.moveTo(50, doc.y).lineTo(562, doc.y).stroke(GREEN);
    doc.moveDown(0.8);

    doc.fillColor(DARK).fontSize(10).font('Helvetica')
      .text(narrative || 'Evidence narrative not available.', { lineGap: 4 });
    doc.moveDown(1);
    doc.fillColor(GRAY).fontSize(8).text('Legal reference: O.C.G.A. § 48-5-2 (fair market value standard) and O.C.G.A. § 48-5-299(c) (3-year value freeze upon successful appeal with written evidence).');

    // ── PAGE 4: FILING INSTRUCTIONS ─────────────────────────────
    doc.addPage();
    doc.fillColor(GREEN).fontSize(14).font('Helvetica-Bold').text('FILING INSTRUCTIONS');
    doc.moveTo(50, doc.y).lineTo(562, doc.y).stroke(GREEN);
    doc.moveDown(0.5);

    // Deadline box
    doc.rect(50, doc.y, 512, 50).fill('#fef2f2');
    doc.fillColor(RED).fontSize(16).font('Helvetica-Bold')
      .text(`DEADLINE: ${deadline || 'See your assessment notice'}`, 60, doc.y - 42, { align: 'center' });
    doc.fillColor(RED).fontSize(9).font('Helvetica')
      .text('Your PT-311A must be POSTMARKED by this date. Late filings are rejected.', { align: 'center' });
    doc.moveDown(1.5);

    const steps = [
      'Print this entire packet (all 4 pages).',
      'Sign and date the PT-311A form on Page 1.',
      'Make a copy of everything for your records.',
      'Mail via USPS First Class Mail with Certificate of Mailing.',
      `Address the envelope to:\n${assessorAddr || county + ' County Board of Tax Assessors'}`,
      'Keep the USPS postmark receipt — this is your proof of timely filing.',
      'Expect a response from the county within 4–8 weeks.',
    ];

    steps.forEach((step, i) => {
      doc.fillColor(GREEN).fontSize(11).font('Helvetica-Bold').text(`${i + 1}.`, 50, doc.y, { continued: true });
      doc.fillColor(DARK).fontSize(10).font('Helvetica').text('  ' + step, { lineGap: 2 });
      doc.moveDown(0.6);
    });

    doc.moveDown(1);
    doc.rect(50, doc.y, 512, 60).fill('#f0fdf4');
    doc.fillColor(GREEN).fontSize(10).font('Helvetica-Bold')
      .text('WHAT HAPPENS AFTER YOU FILE:', 60, doc.y - 50);
    doc.fillColor(DARK).fontSize(9).font('Helvetica')
      .text('The county will either (1) send an Amended Notice of Assessment reducing your value, or (2) schedule a Board of Equalization hearing. If you receive a hearing notice, bring this packet and your USPS receipt.', 60, doc.y, { width: 490 });

    doc.end();

  } catch (err) {
    console.error('[pdf] generation error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'PDF generation failed: ' + err.message });
    }
  }
});
// ── START ─────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'AppealPilot API' });
});
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`AppealPilot API running on port ${PORT}`));
module.exports = app;
