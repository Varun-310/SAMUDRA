// Express server to read ARGO CSVs, process floats, and render EJS map view
const path = require('path');
const fs = require('fs');
const express = require('express');
const readline = require('readline');

const APP_PORT = process.env.PORT || 3000;
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN || 'YOUR_MAPBOX_TOKEN';

const app = express();

// View engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// Static assets
app.use(express.static(path.join(__dirname, 'public')));
// Serve brand/assets from project-level images directory
app.use('/images', express.static(path.join(__dirname, 'images')));

// Utility: Recursively list files under a directory, filtering by extension
function listFilesRecursive(startDir, allowedExts = new Set(['.csv'])) {
  const results = [];
  if (!fs.existsSync(startDir)) return results;

  const stack = [startDir];
  while (stack.length > 0) {
    const current = stack.pop();
    let dirents = [];
    try {
      dirents = fs.readdirSync(current, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const d of dirents) {
      const full = path.join(current, d.name);
      if (d.isDirectory()) {
        stack.push(full);
      } else if (d.isFile()) {
        const ext = path.extname(d.name).toLowerCase();
        if (allowedExts.has(ext)) {
          results.push(full);
        }
      }
    }
  }
  return results;
}

// Basic CSV line parser handling commas and quotes
function parseCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        // Check for escaped quote
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++; // skip escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else {
      if (char === ',') {
        values.push(current);
        current = '';
      } else if (char === '"') {
        inQuotes = true;
      } else {
        current += char;
      }
    }
  }
  values.push(current);
  return values;
}

async function parseCsvFileStream(filePath, onRow) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let header = null;
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (!header) {
        header = parseCsvLine(trimmed).map(h => h.trim());
        return;
      }
      const values = parseCsvLine(line);
      const obj = {};
      for (let i = 0; i < header.length; i++) {
        obj[header[i]] = values[i] !== undefined ? values[i] : '';
      }
      onRow(obj);
    });
    rl.on('close', resolve);
    rl.on('error', reject);
  });
}

function toNumber(value) {
  if (value === undefined || value === null) return null;
  const n = parseFloat(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

function finalizeFloatsFromMap(idToEntries) {
  const floats = [];
  for (const [platform, bucket] of idToEntries.entries()) {
    const entries = bucket.entries;
    entries.sort((a, b) => {
      const aj = a.juld ?? -Infinity;
      const bj = b.juld ?? -Infinity;
      return aj - bj;
    });
    
    // Group entries into cycles based on time gaps and pressure patterns
    const cycles = [];
    let currentCycle = [];
    let lastJuld = null;
    let lastPres = null;
    
    entries.forEach((entry, index) => {
      const timeGap = lastJuld ? Math.abs(entry.juld - lastJuld) : 0;
      const presGap = lastPres ? Math.abs(entry.pres - lastPres) : 0;
      
      // New cycle if: large time gap (>1 day) OR significant pressure change (>50 dbar) OR first entry
      if (index === 0 || timeGap > 1 || (presGap > 50 && entry.pres < lastPres)) {
        if (currentCycle.length > 0) {
          cycles.push([...currentCycle]);
        }
        currentCycle = [entry];
      } else {
        currentCycle.push(entry);
      }
      
      lastJuld = entry.juld;
      lastPres = entry.pres;
    });
    
    if (currentCycle.length > 0) {
      cycles.push(currentCycle);
    }
    
    // Latest cycle is the last one
    const latest = cycles[cycles.length - 1][cycles[cycles.length - 1].length - 1];
    
    // All history data (no capping)
    const allHistory = entries.map(h => ({
      latitude: h.latitude,
      longitude: h.longitude,
      pres: h.pres,
      juld: h.juld,
      temp: h.temp,
      psal: h.psal,
      doxy: h.doxy,
      nitrate: h.nitrate,
      ph: h.ph,
      organization: h.organization,
      dateIso: h.dateIso
    }));
    
    floats.push({
      id: platform,
      type: bucket.type || 'core',
      latest: {
        latitude: latest.latitude,
        longitude: latest.longitude,
        pres: latest.pres,
        juld: latest.juld,
        temp: latest.temp,
        psal: latest.psal,
        doxy: latest.doxy,
        nitrate: latest.nitrate,
        ph: latest.ph,
        organization: latest.organization,
        dateIso: latest.dateIso
      },
      history: allHistory,
      cycles: cycles.map(cycle => cycle.map(h => ({
        latitude: h.latitude,
        longitude: h.longitude,
        pres: h.pres,
        juld: h.juld,
        temp: h.temp,
        psal: h.psal,
        doxy: h.doxy,
        nitrate: h.nitrate,
        ph: h.ph
      })))
    });
  }
  return floats;
}

async function loadFloatsStreaming() {
  const dataDirs = [path.join(__dirname, 'data', 'bgc'), path.join(__dirname, 'data', 'core')];
  let allFiles = [];
  for (const dir of dataDirs) {
    const files = listFilesRecursive(dir, new Set(['.csv']));
    allFiles = allFiles.concat(files);
  }

  if (allFiles.length === 0) {
    console.warn('[WARN] No CSV files found in data/bgc or data/core');
    return [];
  }

  console.log(`[INFO] Found ${allFiles.length} CSV file(s).`);
  const idToEntries = new Map();

  for (const file of allFiles) {
    console.log(`[INFO] Reading: ${path.relative(process.cwd(), file)}`);
    try {
      const sourceType = file.toLowerCase().includes(path.sep + 'bgc' + path.sep) ? 'bgc' : 'core';
      await parseCsvFileStream(file, (r) => {
        // Normalize keys to be case-insensitive
        const keyMap = new Map();
        for (const k of Object.keys(r)) keyMap.set(k.toLowerCase(), k);
        const get = (names) => {
          for (const name of names) {
            const k = keyMap.get(name.toLowerCase());
            if (k && r[k] !== undefined && r[k] !== '') return r[k];
          }
          return '';
        };

        const rawPlatform = get(['PLATFORM_NUMBER', 'platform_number', 'argo_id', 'platformid']);
        const platform = (rawPlatform || '').toString().trim();
        if (!platform) return;
        const lat = toNumber(get(['LATITUDE', 'latitude', 'lat']));
        const lon = toNumber(get(['LONGITUDE', 'longitude', 'lon', 'lng']));
        if (lat === null || lon === null) return;

        const pres = toNumber(get(['PRES', 'pres', 'pressure']));
        const temp = toNumber(get(['TEMP', 'temp', 'temperature']));
        const psal = toNumber(get(['PSAL', 'psal', 'salinity']));
        const doxy = toNumber(get(['DOXY', 'doxy', 'oxygen']));
        const nitrate = toNumber(get(['NITRATE', 'nitrate', 'NITRATE_ADJUSTED', 'nitrate_adjusted']));
        const ph = toNumber(get(['PH_IN_SITU_TOTAL', 'ph_in_situ_total', 'PH_IN_SITU_TOTAL_ADJUSTED', 'ph']));
        const organization = (get(['DATA_CENTRE','data_centre','ORGANIZATION','organization','ORG','org']) || '').toString().trim();

        // JULD and ISO date computation
        const rawJuld = get(['JULD', 'juld', 'JULD_ADJUSTED']);
        const epoch1950 = Date.parse('1950-01-01T00:00:00Z');
        const dayMs = 24 * 60 * 60 * 1000;
        let juld = toNumber(rawJuld);
        let dateIso = null;
        if (juld !== null) {
          dateIso = new Date(epoch1950 + juld * dayMs).toISOString();
        } else {
          const dateStr = (get(['DATE_CREATION', 'date_creation', 'DATE', 'date', 'DATE_UPDATE']) || '').toString();
          const digits = dateStr.replace(/[^0-9]/g, '');
          if (digits.length >= 8) {
            // Parse as yyyymmdd[HHMMSS]
            const y = parseInt(digits.slice(0, 4));
            const m = parseInt(digits.slice(4, 6)) - 1;
            const d = parseInt(digits.slice(6, 8));
            const hh = digits.length >= 10 ? parseInt(digits.slice(8, 10)) : 0;
            const mm = digits.length >= 12 ? parseInt(digits.slice(10, 12)) : 0;
            const ss = digits.length >= 14 ? parseInt(digits.slice(12, 14)) : 0;
            const dtMs = Date.UTC(y, m, d, hh, mm, ss);
            juld = (dtMs - epoch1950) / dayMs;
            dateIso = new Date(dtMs).toISOString();
          } else {
            const cycle = toNumber(get(['CYCLE_NUMBER', 'cycle_number', 'cycle']));
            if (cycle !== null) juld = cycle;
          }
        }
        const entry = {
          latitude: lat,
          longitude: lon,
          pres,
          juld,
          temp,
          psal,
          doxy,
          nitrate,
          ph,
          organization,
          dateIso
        };
        if (!idToEntries.has(platform)) idToEntries.set(platform, { entries: [], type: sourceType });
        const bucket = idToEntries.get(platform);
        bucket.entries.push(entry);
        // If any file for this platform comes from BGC, mark as bgc
        if (sourceType === 'bgc') bucket.type = 'bgc';
      });
    } catch (err) {
      console.error(`[ERROR] Failed to read ${file}:`, err.message);
    }
  }

  return finalizeFloatsFromMap(idToEntries);
}

// Route: Map view
let FLOATS_CACHE = null;
let CACHE_BUILDING = null;

async function ensureCache() {
  if (FLOATS_CACHE) return FLOATS_CACHE;
  if (!CACHE_BUILDING) {
    CACHE_BUILDING = loadFloatsStreaming().then(result => {
      FLOATS_CACHE = result;
      console.log(`[INFO] Processed ${FLOATS_CACHE.length} float(s).`);
      if (FLOATS_CACHE.length > 0) {
        console.log('[INFO] Example floats:', FLOATS_CACHE.slice(0, 5).map(f => f.id).join(', '));
      }
      CACHE_BUILDING = null;
      return FLOATS_CACHE;
    }).catch(err => {
      CACHE_BUILDING = null;
      throw err;
    });
  }
  return CACHE_BUILDING;
}

app.get('/', async (req, res) => {
  try {
    const floats = await ensureCache();
    res.render('map', {
      mapboxToken: MAPBOX_TOKEN,
      floats: [] // Send empty array, load via API
    });
  } catch (err) {
    console.error('[ERROR] Failed to load floats:', err);
    res.status(500).send('Failed to load data');
  }
});

// API endpoint to get floats data (optimized for frontend)
app.get('/api/floats', async (req, res) => {
  try {
    const floats = await ensureCache();
    
    // Create optimized version for frontend - limit history and cycles
    const optimizedFloats = floats.map(float => ({
      id: float.id,
      type: float.type,
      latest: float.latest,
      // Limit history to last 200 points to avoid JSON size issues
      history: float.history.slice(-200),
      // Limit cycles to last 10 cycles, each with max 50 points
      cycles: float.cycles.slice(-10).map(cycle => cycle.slice(-50))
    }));
    
    res.json(optimizedFloats);
  } catch (err) {
    console.error('[ERROR] Failed to load floats:', err);
    res.status(500).json({ error: 'Failed to load data' });
  }
});

// API endpoint to get specific float's complete data
app.get('/api/float/:id', async (req, res) => {
  try {
    const floats = await ensureCache();
    const floatId = req.params.id;
    const float = floats.find(f => f.id === floatId);
    
    if (!float) {
      return res.status(404).json({ error: 'Float not found' });
    }
    
    res.json(float);
  } catch (err) {
    console.error('[ERROR] Failed to load float data:', err);
    res.status(500).json({ error: 'Failed to load float data' });
  }
});

app.listen(APP_PORT, () => {
  console.log(`[INFO] Server listening on http://localhost:${APP_PORT}`);
  // Warm up cache in background
  ensureCache().catch(() => {});
});


