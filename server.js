const express = require("express");
const axios = require("axios");
const path = require("path");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = 3000;
const TIMEOUT = 30000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── ENDPOINT BAZLI RATE LIMITER ─────────────────────────────
// Temel yardımcı — ortak seçenekler
const makeLimit = (max, windowMin = 15) => rateLimit({
  windowMs: windowMin * 60 * 1000,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Çok fazla istek gönderdiniz. Lütfen daha sonra tekrar deneyiniz." },
});

// Canlı konum & SSE — sınır yok (zaten 10sn'de bir SSE ile push ediliyor)
const konumLimiter  = (req, res, next) => next();

// Standart sorgu endpoint'leri (hat, durak, güzergah, analiz) — 1000 istek / 15dk
const generalLimiter = makeLimit(1000);

// Ağır SOAP isteği gerektiren endpoint'ler (arrivals, hat-konum) — 100 istek / 15dk
const heavyLimiter  = makeLimit(100);

// Uygula
app.use("/api/arac-konum",      konumLimiter);
app.use("/api/stream-konum",    konumLimiter);
app.use("/api/hat-konum",       konumLimiter);   // hat bazlı konum da gerçek zamanlı
app.use("/api/tekil-arac-konum",heavyLimiter);
app.use("/api/durak",           generalLimiter); // /api/durak/:id/arrivals aşağıda override edilir
app.use("/api/hat-analiz",      generalLimiter);
app.use("/api/hat",             generalLimiter);
app.use("/api/guzergah",        generalLimiter);
// /api/durak/:id/arrivals — orta ağırlıklı (60 / 15dk)
app.use("/api/durak/:id/arrivals", makeLimit(60));

// XML Escaping Helper
function escapeXml(unsafe) {
  if (typeof unsafe !== 'string') return '';
  return unsafe.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

function parseXmlDataSet(xml) {
  const tables = xml.match(/<Table>([\s\S]*?)<\/Table>/g);
  if (!tables) return [];
  return tables.map(table => {
    const fields = {};
    const matches = table.match(/<([a-zA-Z0-9_]+)>([^<]*)</g);
    if (matches) {
      matches.forEach(m => {
        const parts = m.match(/<([a-zA-Z0-9_]+)>([^<]*)</);
        if (parts) {
          fields[parts[1]] = parts[2];
        }
      });
    }
    return fields;
  });
}

async function getDailyDuties(tarih) {
  const cacheKey = `arsiv-gorev:${tarih}`;
  let archiveXml = getCachedData(cacheKey);

  if (!archiveXml) {
    console.log(`🌐 [DUTIES API] IETT'den arşiv görev verileri çekiliyor (${tarih})...`);
    try {
      archiveXml = await soapRequest(
        "https://api.ibb.gov.tr/iett/ibb/ibb360.asmx",
        "GetIettArsivGorev_json",
        "http://tempuri.org/",
        `<tns:Tarih>${tarih}</tns:Tarih>`
      );
      
      const match = archiveXml.match(/<GetIettArsivGorev_jsonResult>([\s\S]*?)<\/GetIettArsivGorev_jsonResult>/);
      if (match && JSON.parse(match[1]).length > 0) {
        setCachedData(cacheKey, archiveXml, 3600000); // 60 dk cache — arşiv görevleri gün içinde değişmez
      } else {
        throw new Error("Boş görev verisi");
      }
    } catch (err) {
      console.warn(`⚠️ [DUTIES] ${tarih} için arşiv çekilemedi, dünün tarihi denenecek...`);
      
      const currentYear = parseInt(tarih.substring(0, 4), 10);
      const currentMonth = parseInt(tarih.substring(4, 6), 10) - 1;
      const currentDay = parseInt(tarih.substring(6, 8), 10);
      const prevDate = new Date(currentYear, currentMonth, currentDay - 1);
      
      const pYear = prevDate.getFullYear();
      const pMonth = String(prevDate.getMonth() + 1).padStart(2, '0');
      const pDay = String(prevDate.getDate()).padStart(2, '0');
      const dunStr = `${pYear}${pMonth}${pDay}`;
      
      console.log(`🌐 [DUTIES API] Dünün arşiv verileri çekiliyor (${dunStr})...`);
      const prevCacheKey = `arsiv-gorev:${dunStr}`;
      let prevXml = getCachedData(prevCacheKey);
      if (!prevXml) {
        prevXml = await soapRequest(
          "https://api.ibb.gov.tr/iett/ibb/ibb360.asmx",
          "GetIettArsivGorev_json",
          "http://tempuri.org/",
          `<tns:Tarih>${dunStr}</tns:Tarih>`
        );
        setCachedData(prevCacheKey, prevXml, 1800000);
      }
      archiveXml = prevXml;
    }
  }

  const match = archiveXml.match(/<GetIettArsivGorev_jsonResult>([\s\S]*?)<\/GetIettArsivGorev_jsonResult>/);
  if (!match) return [];
  try {
    return JSON.parse(match[1]);
  } catch (e) {
    return [];
  }
}

// Validation Regex Helpers
function validateHatKodu(hatKodu) {
  const regex = /^[a-zA-Z0-9-]{1,20}$/;
  return typeof hatKodu === 'string' && regex.test(hatKodu);
}

function validateDurakKodu(durakKodu) {
  const regex = /^[a-zA-Z0-9-]{1,20}$/;
  return typeof durakKodu === 'string' && regex.test(durakKodu);
}

function validateKapino(kapino) {
  const regex = /^[a-zA-Z0-9-_/]{1,30}$/;
  return typeof kapino === 'string' && regex.test(kapino);
}


// SOAP isteği gönderen yardımcı fonksiyon
async function soapRequest(url, method, namespace, params = "") {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="${namespace}">
  <soapenv:Body>
    <tns:${method}>
      ${params}
    </tns:${method}>
  </soapenv:Body>
</soapenv:Envelope>`;

  const response = await axios.post(url, body, {
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: `"${namespace}${method}"`,
    },
    timeout: TIMEOUT,
  });

  return response.data;
}

// Centralized Cache Store
const cacheStore = new Map();

function getCachedData(key) {
  const cached = cacheStore.get(key);
  if (cached && Date.now() - cached.timestamp < cached.ttl) {
    return cached.data;
  }
  return null;
}

function setCachedData(key, data, ttl) {
  cacheStore.set(key, {
    data,
    timestamp: Date.now(),
    ttl
  });
}

// ─── IN-FLIGHT DEDUPLICATION ──────────────────────────────────
// Aynı anda gelen özdeş isteklerin tek bir SOAP isteğine indirgenmesi.
// Örneğin 5 kullanıcı aynı anda aynı hat güzergahını sorgularsa
// IETT API'ye tek istek gönderilir, diğerleri sonucu bekler.
const inFlight = new Map();

async function dedupedSoapRequest(cacheKey, ttl, ...soapArgs) {
  // Cache'de varsa hemen dön
  const cached = getCachedData(cacheKey);
  if (cached) return cached;

  // Uçuştaki bir istek varsa ona katıl
  if (inFlight.has(cacheKey)) {
    return inFlight.get(cacheKey);
  }

  // Yeni istek başlat
  const promise = soapRequest(...soapArgs)
    .then(data => {
      setCachedData(cacheKey, data, ttl);
      inFlight.delete(cacheKey);
      return data;
    })
    .catch(err => {
      inFlight.delete(cacheKey);
      throw err;
    });

  inFlight.set(cacheKey, promise);
  return promise;
}

// Backward compatibility helper for existing SSE implementation
const cache = {
  get konum() {
    return {
      get data() {
        const c = cacheStore.get("arac-konum");
        return c ? c.data : null;
      },
      set data(val) {
        setCachedData("arac-konum", val, 30000); // 30s TTL
      },
      get timestamp() {
        const c = cacheStore.get("arac-konum");
        return c ? c.timestamp : 0;
      },
      set timestamp(val) {
        const c = cacheStore.get("arac-konum");
        if (c) c.timestamp = val;
      },
      ttl: 30000
    };
  }
};

// Async Handler Middleware to catch exceptions and pass to express error handler
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// ─── ENDPOINTS ────────────────────────────────────────────────

// 1. Hat bilgisi getir
// GET /api/hat/:hatKodu
app.get("/api/hat/:hatKodu", asyncHandler(async (req, res) => {
  const { hatKodu } = req.params;
  if (!validateHatKodu(hatKodu)) {
    return res.status(400).json({ error: "Geçersiz Hat Kodu formatı" });
  }

  const cacheKey = `hat:${hatKodu.toLowerCase()}`;
  const cached = getCachedData(cacheKey);
  if (cached) {
    console.log(`⚡ [CACHE] Hat bilgisi önbellekten sunuluyor: ${hatKodu}`);
    return res.type("xml").send(cached);
  }

  const escapedHatKodu = escapeXml(hatKodu);
  const data = await dedupedSoapRequest(
    cacheKey,
    1800000, // 30 dakika cache
    "https://api.ibb.gov.tr/iett/UlasimAnaVeri/HatDurakGuzergah.asmx",
    "GetHat_json",
    "http://tempuri.org/",
    `<tns:HatKodu>${escapedHatKodu}</tns:HatKodu>`
  );

  res.type("xml").send(data);
}));

// 2. Durak bilgisi getir
// GET /api/durak/:durakKodu
app.get("/api/durak/:durakKodu", asyncHandler(async (req, res) => {
  const { durakKodu } = req.params;
  if (!validateDurakKodu(durakKodu)) {
    return res.status(400).json({ error: "Geçersiz Durak Kodu formatı" });
  }

  const cacheKey = `durak:${durakKodu.toLowerCase()}`;
  const cached = getCachedData(cacheKey);
  if (cached) {
    console.log(`⚡ [CACHE] Durak bilgisi önbellekten sunuluyor: ${durakKodu}`);
    return res.type("xml").send(cached);
  }

  const escapedDurakKodu = escapeXml(durakKodu);
  const data = await dedupedSoapRequest(
    cacheKey,
    1800000, // 30 dakika cache
    "https://api.ibb.gov.tr/iett/UlasimAnaVeri/HatDurakGuzergah.asmx",
    "GetDurak_json",
    "http://tempuri.org/",
    `<tns:DurakKodu>${escapedDurakKodu}</tns:DurakKodu>`
  );

  res.type("xml").send(data);
}));

// 3. Hat güzergahı
// GET /api/guzergah/:hatKodu
app.get("/api/guzergah/:hatKodu", asyncHandler(async (req, res) => {
  const { hatKodu } = req.params;
  if (!validateHatKodu(hatKodu)) {
    return res.status(400).json({ error: "Geçersiz Hat Kodu formatı" });
  }

  const cacheKey = `guzergah:${hatKodu.toLowerCase()}`;
  const cachedXml = getCachedData(cacheKey);
  if (cachedXml) {
    console.log(`⚡ [CACHE] Güzergah bilgisi önbellekten sunuluyor: ${hatKodu}`);
    // Cache içeriği zaten xml response formatında mı yoksa parse edilmiş mi kontrol et
    return res.type("xml").send(cachedXml);
  }

  const escapedHatKodu = escapeXml(hatKodu);
  // dedupedSoapRequest ile aynı anda gelen güzergah isteklerini birleştir
  const data = await dedupedSoapRequest(
    `__raw_guzergah:${hatKodu.toLowerCase()}`,
    1800000, // 30 dakika
    "https://api.ibb.gov.tr/iett/ibb/ibb.asmx",
    "DurakDetay_GYY",
    "http://tempuri.org/",
    `<tns:hat_kodu>${escapedHatKodu}</tns:hat_kodu>`
  );

  const parsed = parseXmlDataSet(data);
  const jsonStr = JSON.stringify(parsed);
  const xmlResponse = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><DurakDetay_GYYResponse xmlns="http://tempuri.org/"><DurakDetay_GYYResult>${jsonStr}</DurakDetay_GYYResult></DurakDetay_GYYResponse></soap:Body></soap:Envelope>`;

  setCachedData(cacheKey, xmlResponse, 1800000); // 30 dakika cache
  res.type("xml").send(xmlResponse);
}));

// 4. Hat Bazlı Canlı Araç Konumu
// GET /api/hat-konum/:hatKodu
app.get("/api/hat-konum/:hatKodu", asyncHandler(async (req, res) => {
  const { hatKodu } = req.params;
  if (!validateHatKodu(hatKodu)) {
    return res.status(400).json({ error: "Geçersiz Hat Kodu formatı" });
  }

  const cacheKey = `hat-konum:${hatKodu.toLowerCase()}`;
  const cached = getCachedData(cacheKey);
  if (cached) {
    console.log(`⚡ [CACHE] Hat konum verisi önbellekten sunuluyor: ${hatKodu}`);
    return res.type("xml").send(cached);
  }

  // Uçuştaki isteği kontrol et
  if (inFlight.has(cacheKey)) {
    console.log(`⚡ [DEDUP] Hat konum isteği birleştirildi: ${hatKodu}`);
    const data = await inFlight.get(cacheKey);
    return res.type("xml").send(data);
  }

  const escapedHatKodu = escapeXml(hatKodu);
  const body = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="http://tempuri.org/">
  <soapenv:Header>
    <tns:AuthHeader>
      <tns:Username></tns:Username>
      <tns:Password></tns:Password>
    </tns:AuthHeader>
  </soapenv:Header>
  <soapenv:Body>
    <tns:GetHatOtoKonum_json>
      <tns:HatKodu>${escapedHatKodu}</tns:HatKodu>
    </tns:GetHatOtoKonum_json>
  </soapenv:Body>
</soapenv:Envelope>`;

  const promise = (async () => {
    const response = await axios.post("https://api.ibb.gov.tr/iett/FiloDurum/SeferGerceklesme.asmx", body, {
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: '"http://tempuri.org/GetHatOtoKonum_json"',
      },
      timeout: TIMEOUT,
    });
    return response.data;
  })();

  inFlight.set(cacheKey, promise);

  try {
    const data = await promise;
    setCachedData(cacheKey, data, 15000); // 15 saniye cache
    res.type("xml").send(data);
  } finally {
    inFlight.delete(cacheKey);
  }
}));

// 5. Tekil Araç Konumu (Filtreli ve Hat Çözümlemeli)
// GET /api/tekil-arac-konum/:hatKodu/:kapino
// GET /api/tekil-arac-konum/:kapino
const handleTekilAracKonum = asyncHandler(async (req, res) => {
  let { hatKodu, kapino } = req.params;

  // Rota eşleşmesine göre parametreleri düzenle
  if (!kapino) {
    kapino = hatKodu;
    hatKodu = undefined;
  }

  if (hatKodu === "undefined" || hatKodu === "null") {
    hatKodu = undefined;
  }

  if (!kapino || !validateKapino(kapino)) {
    return res.status(400).json({ error: "Geçersiz Kapı No formatı" });
  }

  // Hat kodu bilinmiyorsa önbellekteki veya IETT'den çekilen arşiv görev verisinden bul
  if (!hatKodu) {
    console.log(`🔍 [TEKİL] Hat kodu eksik, ${kapino} için görev arşivinde aranıyor...`);
    const tzDate = new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Istanbul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date());
    const year = tzDate.find(p => p.type === 'year').value;
    const month = tzDate.find(p => p.type === 'month').value;
    const day = tzDate.find(p => p.type === 'day').value;
    const bugunStr = `${year}${month}${day}`;

    const allDuties = await getDailyDuties(bugunStr);
    const duty = allDuties.find(d => (d.SKAPINUMARA || '').toLowerCase() === kapino.toLowerCase());
    if (duty) {
      hatKodu = duty.SHATKODU;
      console.log(`🎯 [TEKİL] ${kapino} için Hat Kodu bulundu: ${hatKodu}`);
    }
  }

  if (!hatKodu || !validateHatKodu(hatKodu)) {
    return res.status(404).json({ error: `Araç hat bilgisi bulunamadı (Kapı No: ${kapino})` });
  }

  // Hat konumunu çek (ya cache'den ya API'den)
  const cacheKey = `hat-konum:${hatKodu.toLowerCase()}`;
  let hatXml = getCachedData(cacheKey);

  if (!hatXml) {
    console.log(`🌐 [TEKİL API] IETT'den hat konum verisi çekiliyor (Hat: ${hatKodu})...`);
    const escapedHatKodu = escapeXml(hatKodu);
    const body = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="http://tempuri.org/">
  <soapenv:Header>
    <tns:AuthHeader>
      <tns:Username></tns:Username>
      <tns:Password></tns:Password>
    </tns:AuthHeader>
  </soapenv:Header>
  <soapenv:Body>
    <tns:GetHatOtoKonum_json>
      <tns:HatKodu>${escapedHatKodu}</tns:HatKodu>
    </tns:GetHatOtoKonum_json>
  </soapenv:Body>
</soapenv:Envelope>`;

    const response = await axios.post("https://api.ibb.gov.tr/iett/FiloDurum/SeferGerceklesme.asmx", body, {
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: '"http://tempuri.org/GetHatOtoKonum_json"',
      },
      timeout: TIMEOUT,
    });
    
    hatXml = response.data;
    setCachedData(cacheKey, hatXml, 10000); // 10s cache
  } else {
    console.log(`⚡ [TEKİL CACHE] Hat konum verisi önbellekten kullanılıyor (Hat: ${hatKodu})`);
  }

  const match = hatXml.match(/<GetHatOtoKonum_jsonResult>([\s\S]*?)<\/GetHatOtoKonum_jsonResult>/);
  if (!match) return res.status(404).json({ error: "Veri bulunamadı" });

  const allVehicles = JSON.parse(match[1]);
  const vehicle = allVehicles.find(v => (v.kapino || '').toLowerCase() === kapino.toLowerCase());

  if (!vehicle) return res.status(404).json({ error: "Araç bulunamadı" });

  res.json(vehicle);
});

// Durak Bazlı Yaklaşan Otobüsler ve ETA (Tahmini Varış Süresi)
// GET /api/durak/:durakKodu/arrivals
app.get("/api/durak/:durakKodu/arrivals", asyncHandler(async (req, res) => {
  const { durakKodu } = req.params;
  if (!validateDurakKodu(durakKodu)) {
    return res.status(400).json({ error: "Geçersiz Durak Kodu formatı" });
  }

  // 1. Durak detaylarını çek — varsa cache'den kullan, yoksa dedup ile çek
  const durakCacheKey = `durak:${durakKodu.toLowerCase()}`;
  const durakXml = await dedupedSoapRequest(
    durakCacheKey,
    1800000, // 30 dakika
    "https://api.ibb.gov.tr/iett/UlasimAnaVeri/HatDurakGuzergah.asmx",
    "GetDurak_json",
    "http://tempuri.org/",
    `<tns:DurakKodu>${escapeXml(durakKodu)}</tns:DurakKodu>`
  );

  const durakMatch = durakXml.match(/<GetDurak_jsonResult>([\s\S]*?)<\/GetDurak_jsonResult>/);
  if (!durakMatch) {
    return res.status(404).json({ error: "Durak bulunamadı" });
  }
  const durakInfo = JSON.parse(durakMatch[1])[0];
  if (!durakInfo) {
    return res.status(404).json({ error: "Durak verisi bulunamadı" });
  }

  const coords = durakInfo.KOORDINAT.match(/([0-9.]+)\s+([0-9.]+)/);
  if (!coords) {
    return res.status(400).json({ error: "Durak koordinat bilgisi geçersiz" });
  }
  const stopLng = parseFloat(coords[1]);
  const stopLat = parseFloat(coords[2]);

  // 2. Tüm aktif araç konumlarını al — SSE ile zaten önbellekleniyor; 
  //    yoksa tek seferlik dedup ile çek (birden fazla arrivals isteğini birleştir)
  let fleetXml = getCachedData("arac-konum") ||
    await dedupedSoapRequest(
      "arac-konum",
      15000, // 15 saniye
      "https://api.ibb.gov.tr/iett/FiloDurum/SeferGerceklesme.asmx",
      "GetFiloAracKonum_json",
      "http://tempuri.org/",
      ""
    );

  const fleetMatch = fleetXml.match(/<GetFiloAracKonum_jsonResult>([\s\S]*?)<\/GetFiloAracKonum_jsonResult>/);
  if (!fleetMatch) {
    return res.json([]);
  }
  const fleetVehicles = JSON.parse(fleetMatch[1]);

  // Haversine mesafe hesaplayıcı
  function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const phi1 = lat1 * Math.PI/180;
    const phi2 = lat2 * Math.PI/180;
    const deltaPhi = (lat2-lat1) * Math.PI/180;
    const deltaLambda = (lon2-lon1) * Math.PI/180;
    const a = Math.sin(deltaPhi/2) * Math.sin(deltaPhi/2) +
              Math.cos(phi1) * Math.cos(phi2) *
              Math.sin(deltaLambda/2) * Math.sin(deltaLambda/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }

  // 3. Durağa 3.5 km yarıçapındaki aday araçları filtrele
  const nearbyCandidates = fleetVehicles.filter(v => {
    const vLat = parseFloat(v.Enlem || v.enlem);
    const vLng = parseFloat(v.Boylam || v.boylam);
    if (isNaN(vLat) || isNaN(vLng)) return false;
    const dist = getDistance(stopLat, stopLng, vLat, vLng);
    v.distance = dist;
    return dist <= 1500;
  });

  if (nearbyCandidates.length === 0) {
    return res.json([]);
  }

  // Bugünün görev arşivini çek
  const tzDate = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const year = tzDate.find(p => p.type === 'year').value;
  const month = tzDate.find(p => p.type === 'month').value;
  const day = tzDate.find(p => p.type === 'day').value;
  const bugunStr = `${year}${month}${day}`;
  const allDuties = await getDailyDuties(bugunStr);

  console.log(`🔍 [ARRIVALS] Durak: ${durakKodu}, Koordinatlar: ${stopLat}, ${stopLng}`);
  console.log(`🔍 [ARRIVALS] Toplam araç: ${fleetVehicles.length}, Yakın aday (1.5km): ${nearbyCandidates.length}`);

  const uniqueHats = new Set();
  const vehicleHats = [];

  for (const vehicle of nearbyCandidates) {
    const kapi = (vehicle.KapiNo || vehicle.kapino || '').toLowerCase();
    if (!kapi) continue;

    const cleanKapi = kapi.replace(/-/g, '');
    const duty = allDuties.find(d => {
      const dKapi = (d.SKAPINUMARA || '').toLowerCase().replace(/-/g, '');
      return dKapi === cleanKapi;
    });

    if (duty && duty.SHATKODU) {
      uniqueHats.add(duty.SHATKODU.toLowerCase());
      vehicleHats.push({ vehicle, hatKodu: duty.SHATKODU });
    } else {
      // console.log(`🔍 [ARRIVALS] Araç ${kapi} için görev bulunamadı.`);
    }
  }

  // Güzergahları paralel çek
  const guzergahMap = new Map();
  await Promise.all(Array.from(uniqueHats).map(async (hat) => {
    const guzergahCacheKey = `guzergah:${hat}`;
    let parsedGuzergah = getCachedData(guzergahCacheKey);
    if (!parsedGuzergah) {
      try {
        // Aynı hat güzergahına birden fazla arrivals isteği gelirse dedup ile birleştir
        const rawKey = `__raw_guzergah:${hat}`;
        const guzergahXml = await dedupedSoapRequest(
          rawKey,
          1800000, // 30 dakika
          "https://api.ibb.gov.tr/iett/ibb/ibb.asmx",
          "DurakDetay_GYY",
          "http://tempuri.org/",
          `<tns:hat_kodu>${escapeXml(hat.toUpperCase())}</tns:hat_kodu>`
        );
        parsedGuzergah = parseXmlDataSet(guzergahXml);
        setCachedData(guzergahCacheKey, parsedGuzergah, 1800000); // 30 dakika
      } catch (err) {
        console.error(`Güzergah çekilemedi (${hat}):`, err.message);
        return;
      }
    }

    let guzergahStops = parsedGuzergah;
    if (typeof parsedGuzergah === 'string') {
      guzergahStops = parseXmlDataSet(parsedGuzergah);
    }
    guzergahMap.set(hat, guzergahStops);
  }));

  const arrivals = [];

  // Aday araçların güzergahlarını kontrol et
  for (const { vehicle, hatKodu } of vehicleHats) {
    const guzergahStops = guzergahMap.get(hatKodu.toLowerCase());
    if (!guzergahStops || !Array.isArray(guzergahStops)) continue;

    const targetStopInGuz = guzergahStops.find(s => String(s.DURAKKODU || s.sdurakkodu) === durakKodu);
    if (!targetStopInGuz) continue;

    const targetSira = parseInt(targetStopInGuz.SIRANO || targetStopInGuz.sira || 0);
    const targetYon = targetStopInGuz.YON || targetStopInGuz.yon;

    // Aracın anlık koordinatına en yakın güzergah durağını bul
    const vLat = parseFloat(vehicle.Enlem || vehicle.enlem);
    const vLng = parseFloat(vehicle.Boylam || vehicle.boylam);

    let minDistance = Infinity;
    let closestStop = null;

    guzergahStops.forEach(s => {
      if (s.YON !== targetYon) return;
      const sLat = parseFloat(s.YKOORDINATI || s.enlem);
      const sLng = parseFloat(s.XKOORDINATI || s.boylam);
      if (isNaN(sLat) || isNaN(sLng)) return;

      const d = getDistance(vLat, vLng, sLat, sLng);
      if (d < minDistance) {
        minDistance = d;
        closestStop = s;
      }
    });

    if (!closestStop) continue;

    const aracSira = parseInt(closestStop.SIRANO || closestStop.sira || 0);

    // Araç durağa henüz gelmediyse (sıra no hedef sıradan küçükse)
    if (aracSira < targetSira) {
      const dist = getDistance(vLat, vLng, stopLat, stopLng);
      const speed = parseFloat(vehicle.Hiz || vehicle.hiz) || 0;
      let calcSpeed = speed;
      if (speed < 2) calcSpeed = 15;
      else if (speed < 10) calcSpeed = 12;

      const travelTimeMins = ((dist / 1000) / calcSpeed) * 60;
      const displayMins = Math.round(travelTimeMins);

      arrivals.push({
        line: hatKodu,
        plate: vehicle.Plaka || vehicle.plaka || '—',
        minutes: displayMins,
        distance: Math.round(dist)
      });
    }
  }

  arrivals.sort((a, b) => a.minutes - b.minutes);
  res.json(arrivals.slice(0, 5));
}));

app.get("/api/tekil-arac-konum/:hatKodu/:kapino", handleTekilAracKonum);
app.get("/api/tekil-arac-konum/:kapino", handleTekilAracKonum);

// 5.5. Hat Bazlı Planlanan Görevler ve Durum Analizi
const handleHatAnaliz = asyncHandler(async (req, res) => {
  const { hatKodu } = req.params;
  let { tarih } = req.params;

  if (!validateHatKodu(hatKodu)) {
    return res.status(400).json({ error: "Geçersiz Hat Kodu formatı" });
  }

  // Tarih parametresi yoksa veya geçersizse bugünün tarihini (Europe/Istanbul) al
  const tzDate = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  
  const year = tzDate.find(p => p.type === 'year').value;
  const month = tzDate.find(p => p.type === 'month').value;
  const day = tzDate.find(p => p.type === 'day').value;
  const bugunStr = `${year}${month}${day}`;

  if (!tarih || !/^\d{8}$/.test(tarih)) {
    tarih = bugunStr;
  }

  const isToday = tarih === bugunStr;

  // 1. Görev arşiv verisini çek (getDailyDuties ile)
  const allDuties = await getDailyDuties(tarih);
  if (!allDuties || allDuties.length === 0) {
    return res.status(404).json({ error: "Arşiv verisi bulunamadı veya boş" });
  }

  // Hat koduna göre görevleri filtrele
  const lineDuties = allDuties.filter(d => (d.SHATKODU || '').toLowerCase() === hatKodu.toLowerCase());

  // 2. Bugün sorgulanıyorsa canlı araç konumlarını da çek
  let activeVehicles = [];
  if (isToday && lineDuties.length > 0) {
    const hatKonumCacheKey = `hat-konum:${hatKodu.toLowerCase()}`;
    let hatKonumXml = getCachedData(hatKonumCacheKey);

    if (!hatKonumXml) {
      console.log(`🌐 [ANALİZ API] IETT'den anlık hat konum verisi çekiliyor (${hatKodu})...`);
      const escapedHatKodu = escapeXml(hatKodu);
      const body = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="http://tempuri.org/">
  <soapenv:Header>
    <tns:AuthHeader>
      <tns:Username></tns:Username>
      <tns:Password></tns:Password>
    </tns:AuthHeader>
  </soapenv:Header>
  <soapenv:Body>
    <tns:GetHatOtoKonum_json>
      <tns:HatKodu>${escapedHatKodu}</tns:HatKodu>
    </tns:GetHatOtoKonum_json>
  </soapenv:Body>
</soapenv:Envelope>`;

      try {
        const response = await axios.post("https://api.ibb.gov.tr/iett/FiloDurum/SeferGerceklesme.asmx", body, {
          headers: {
            "Content-Type": "text/xml; charset=utf-8",
            SOAPAction: '"http://tempuri.org/GetHatOtoKonum_json"',
          },
          timeout: TIMEOUT,
        });
        hatKonumXml = response.data;
        setCachedData(hatKonumCacheKey, hatKonumXml, 10000); // 10s cache
      } catch (err) {
        console.error("❌ Canlı hat konum çekilemedi, sadece arşiv görevi gösterilecek:", err.message);
      }
    }

    if (hatKonumXml) {
      const liveMatch = hatKonumXml.match(/<GetHatOtoKonum_jsonResult>([\s\S]*?)<\/GetHatOtoKonum_jsonResult>/);
      if (liveMatch) {
        try {
          activeVehicles = JSON.parse(liveMatch[1]);
        } catch (e) {}
      }
    }
  }

  // 3. Eşleştirme ve Sınıflandırma Mantığı
  const results = lineDuties.map(duty => {
    const kapino = duty.SKAPINUMARA;
    
    // Canlı araç listesinde var mı?
    const activeVehicle = activeVehicles.find(v => (v.kapino || '').toLowerCase() === (kapino || '').toLowerCase());
    
    // Zamanları parse et
    const plannedStart = parseSoapDate(duty.DTPLANLANANBASLANGICZAMANI || duty.DTDUZENLENENBASLANGICZAMANI);
    const actualStart = parseSoapDate(duty.DTBASLAMAZAMANI);
    const actualEnd = parseSoapDate(duty.DTBITISZAMANI);
    
    let sinyalDurumu = 'pasif';
    let durumAciklama = 'Bilinmiyor';

    // Durum açıklamaları ve sinyal durumu tespiti
    if (activeVehicle) {
      sinyalDurumu = 'aktif';
      durumAciklama = 'Seferde (Aktif)';
    } else {
      const stateCode = duty.SGOREVDURUM; // T, I, YK, B, A
      if (stateCode === 'T') {
        sinyalDurumu = 'pasif';
        durumAciklama = 'Görev Tamamlandı';
      } else if (stateCode === 'I') {
        sinyalDurumu = 'pasif';
        durumAciklama = 'Görev İptal Edildi';
      } else if (stateCode === 'YK') {
        sinyalDurumu = 'arizali';
        durumAciklama = 'Yerine Getirilmedi / Arızalı';
      } else {
        // 'B' (Başlamadı/Beklemede) veya 'A' (Aktif/Görevde fakat sinyal yok)
        const simdi = new Date();
        if (plannedStart && plannedStart > simdi) {
          sinyalDurumu = 'beklemede';
          durumAciklama = 'Sefer Saatini Bekliyor';
        } else if (isToday) {
          sinyalDurumu = 'iletisim_kesildi';
          durumAciklama = 'İletişim Kesildi (Konum Yok)';
        } else {
          sinyalDurumu = 'pasif';
          durumAciklama = 'Süre Aşımı / Konum Yok';
        }
      }
    }

    return {
      kapino,
      guzergahkodu: duty.SGUZERGAHKODU,
      planlananBaslangic: plannedStart,
      gercekBaslangic: actualStart,
      gercekBitis: actualEnd,
      gorevDurum: duty.SGOREVDURUM,
      durumAciklama,
      sinyalDurumu,
      konum: activeVehicle ? {
        enlem: activeVehicle.enlem,
        boylam: activeVehicle.boylam,
        hiz: activeVehicle.hiz || '0',
        yon: activeVehicle.yon || '',
        sonKonumZamani: activeVehicle.son_konum_zamani || ''
      } : null
    };
  });

  // Ekstra: Eğer canlı araç listesinde olup görev arşivinde görünmeyen bir araç varsa onu da "Ek Sefer" olarak ekle
  activeVehicles.forEach(v => {
    const kapino = v.kapino;
    const exists = results.some(r => (r.kapino || '').toLowerCase() === (kapino || '').toLowerCase());
    if (!exists) {
      results.push({
        kapino,
        guzergahkodu: v.guzergahkodu || '',
        planlananBaslangic: null,
        gercekBaslangic: parseSoapDate(v.son_konum_zamani),
        gercekBitis: null,
        gorevDurum: 'AKTIF',
        durumAciklama: 'Ek Sefer (Plan Dışı Aktif)',
        sinyalDurumu: 'aktif',
        konum: {
          enlem: v.enlem,
          boylam: v.boylam,
          hiz: v.hiz || '0',
          yon: v.yon || '',
          sonKonumZamani: v.son_konum_zamani || ''
        }
      });
    }
  });

  res.json({
    tarih,
    hatKodu,
    tasks: results
  });
});

app.get("/api/hat-analiz/:hatKodu", handleHatAnaliz);
app.get("/api/hat-analiz/:hatKodu/:tarih", handleHatAnaliz);

// SOAP Date Helper
function parseSoapDate(dateStr) {
  if (!dateStr) return null;
  const match = dateStr.match(/\/Date\((\d+)\)\//);
  if (match) {
    return new Date(parseInt(match[1], 10));
  }
  try {
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? null : d;
  } catch(e) {
    return null;
  }
}

// 6. Canlı araç konumları
// GET /api/arac-konum
app.get("/api/arac-konum", asyncHandler(async (req, res) => {
  const cacheKey = "arac-konum";
  const cached = getCachedData(cacheKey);
  if (cached) {
    console.log("⚡ [CACHE] Canlı konum verisi önbellekten sunuluyor.");
    return res.type("xml").send(cached);
  }

  console.log("🌐 [API] IETT servisinden taze veri çekiliyor...");
  const data = await soapRequest(
    "https://api.ibb.gov.tr/iett/FiloDurum/SeferGerceklesme.asmx",
    "GetFiloAracKonum_json",
    "http://tempuri.org/",
    ""
  );
  
  setCachedData(cacheKey, data, 15000); // 15s cache
  res.type("xml").send(data);
}));

// SSE İstemcileri ve Döngü Yönetimi
const sseClients = [];
let sseInterval = null;

function startSseInterval() {
  console.log("📡 [SSE] Arka plan veri çekme döngüsü başlatıldı (10sn).");
  sseInterval = setInterval(async () => {
    if (sseClients.length === 0) {
      clearInterval(sseInterval);
      sseInterval = null;
      console.log("📡 [SSE] Aktif istemci kalmadı, arka plan döngüsü durduruldu.");
      return;
    }
    try {
      console.log("📡 [SSE] IETT'den taze veri çekiliyor...");
      const data = await soapRequest(
        "https://api.ibb.gov.tr/iett/FiloDurum/SeferGerceklesme.asmx",
        "GetFiloAracKonum_json",
        "http://tempuri.org/",
        ""
      );
      
      // Önbelleği güncelle
      cache.konum.data = data;
      cache.konum.timestamp = Date.now();
      
      const match = data.match(/<GetFiloAracKonum_jsonResult>([\s\S]*?)<\/GetFiloAracKonum_jsonResult>/);
      if (match) {
        const parsedData = JSON.parse(match[1]);
        const ssePayload = JSON.stringify({ type: 'update', data: parsedData });
        sseClients.forEach(client => {
          client.write(`data: ${ssePayload}\n\n`);
        });
        console.log(`📡 [SSE] ${parsedData.length} araç verisi ${sseClients.length} istemciye itildi.`);
      }
    } catch (e) {
      console.error("❌ [SSE ERROR] Canlı konum çekme hatası:", e.message);
      sseClients.forEach(client => {
        client.write(`data: ${JSON.stringify({ type: 'error', message: e.message })}\n\n`);
      });
    }
  }, 10000);
}

app.get("/api/stream-konum", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders(); // HTTP headers gönderme garantisi

  // İlk bağlantı bildirimi
  res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

  // Eğer cache'de veri varsa hemen gönder
  if (cache.konum.data) {
    const match = cache.konum.data.match(/<GetFiloAracKonum_jsonResult>([\s\S]*?)<\/GetFiloAracKonum_jsonResult>/);
    if (match) {
      try {
        const parsedData = JSON.parse(match[1]);
        res.write(`data: ${JSON.stringify({ type: "update", data: parsedData })}\n\n`);
      } catch (e) {}
    }
  }

  // İstemciyi kaydet
  sseClients.push(res);
  console.log(`📡 [SSE] Yeni istemci bağlandı. Toplam istemci: ${sseClients.length}`);

  // Döngü başlamamışsa başlat
  if (!sseInterval) {
    startSseInterval();
  }

  // Bağlantı koptuğunda temizle
  req.on("close", () => {
    const index = sseClients.indexOf(res);
    if (index !== -1) {
      sseClients.splice(index, 1);
    }
    console.log(`📡 [SSE] İstemci ayrıldı. Kalan istemci: ${sseClients.length}`);
    if (sseClients.length === 0 && sseInterval) {
      clearInterval(sseInterval);
      sseInterval = null;
      console.log("📡 [SSE] Aktif istemci kalmadı, arka plan döngüsü durduruldu.");
    }
  });
});

// Centralized Error Handler Middleware
app.use((err, req, res, next) => {
  if (err.response) {
    console.error(`❌ [ERROR] ${req.method} ${req.originalUrl}:`, err.response.status, err.response.data);
  } else {
    console.error(`❌ [ERROR] ${req.method} ${req.originalUrl}:`, err.message);
  }
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`🚌 IETT Proxy çalışıyor → http://localhost:${PORT}`);
});
