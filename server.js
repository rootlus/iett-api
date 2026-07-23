/**
 * İBB İETT GeoJSON API — tek dosyalık backend
 * -------------------------------------------
 * İstanbul Büyükşehir Belediyesi'nin SOAP servislerini (durak, garaj, filo, duyuru)
 * çekip GeoJSON / JSON olarak sunan minimal Express API.
 *
 * Kurulum:
 *   npm init -y
 *   npm install express cors soap xml2js
 *
 * Çalıştırma:
 *   node server.js
 *   (varsayılan port 3000, PORT env değişkeniyle değiştirilebilir)
 *
 * Endpointler:
 *   GET /                -> API bilgisi (sağlık kontrolü)
 *   GET /api/durak?kod=  -> Durak konumları (GeoJSON). ?kod= ile tekil durak filtrelenebilir
 *   GET /api/garaj       -> Garaj konumları (GeoJSON)
 *   GET /api/filo        -> Anlık otobüs konumları (GeoJSON)
 *   GET /api/sefer       -> Sefer/durak verisi (GeoJSON) — durak.js ile aynı SOAP metodunu kullanır
 *   GET /api/duyuru      -> İETT duyuruları (düz JSON)
 *
 * Not: SOAP servisleri her gece 00:15'ten sonra kapanıyor ve durak sayısı fazla
 * olduğu için yanıt süresi normalden uzun olabiliyor.
 */

const express = require('express');
const cors = require('cors');
const soap = require('soap');
const xml2js = require('xml2js');

const app = express();
const PORT = process.env.PORT || 3000;

// SOAP servis WSDL adresleri
const WSDL_ANA_VERI = 'https://api.ibb.gov.tr/iett/UlasimAnaVeri/HatDurakGuzergah.asmx?wsdl';
const WSDL_DUYURU = 'https://api.ibb.gov.tr/iett/UlasimDinamikVeri/Duyurular.asmx?wsdl';
const WSDL_FILO = 'https://api.ibb.gov.tr/iett/FiloDurum/SeferGerceklesme.asmx?wsdl';
const WSDL_IBB = 'https://api.ibb.gov.tr/iett/ibb/ibb.asmx?wsdl'; // DurakDetay_GYY, HatServisi_GYY

// --- Middleware ---
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// --- Statik frontend ---
const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));

// --- Yardımcı fonksiyonlar ---

// "POINT (29.01 41.05)" formatındaki WKT metnini [lon, lat] dizisine çevirir
function wktPointToCoords(wkt) {
  if (!wkt) return null;
  const coordsOnly = String(wkt).replace(/^POINT\s*\(/i, '').replace(/\)$/, '').trim();
  const coords = coordsOnly.split(/\s+/).map(Number);
  if (coords.length !== 2 || coords.some(isNaN)) return null;
  return coords;
}

// İki koordinat arası kuş uçuşu mesafeyi metre cinsinden döndürür (Haversine formülü)
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Dünya yarıçapı (metre)
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// SOAP client oluşturup metodu çağıran ortak yardımcı
function callSoap(wsdlUrl, methodName, args, res, onSuccess) {
  soap.createClient(wsdlUrl, function (err, client) {
    if (err) {
      console.error('SOAP Client Creation Error:', err);
      return res.status(500).json({ error: 'SOAP servisine bağlanılamadı' });
    }

    if (typeof client[methodName] !== 'function') {
      console.error('SOAP Method Not Found:', methodName);
      return res.status(500).json({ error: 'SOAP metodu bulunamadı: ' + methodName });
    }

    client[methodName](args, function (err, result) {
      if (err) {
        console.error('SOAP Request Error:', err);
        return res.status(500).json({ error: 'SOAP servisi isteği başarısız' });
      }
      onSuccess(result);
    });
  });
}

// --- Routes ---

app.get('/', (req, res) => {
  res.json({
    title: 'İBB İETT GeoJSON API',
    endpoints: [
      '/api/durak',
      '/api/hat',
      '/api/garaj',
      '/api/filo',
      '/api/sefer',
      '/api/duyuru',
      '/api/varis-tahmini',
      '/api/hat-arac-durum',
      '/api/hat-duraklari',
    ],
  });
});

// Durak konumları (GeoJSON) — ?kod=219802 ile tekil durak sorgulanabilir
app.get('/api/durak', (req, res) => {
  const durakKodu = req.query.kod || '';
  callSoap(WSDL_ANA_VERI, 'GetDurak_json', { DurakKodu: durakKodu }, res, function (result) {
    let geojson = { type: 'FeatureCollection', features: [] };
    let data;
    try {
      data = JSON.parse(result.GetDurak_jsonResult);
    } catch (e) {
      console.error('JSON Parse Error:', e);
      return res.status(500).json({ error: 'Geçersiz JSON verisi alındı' });
    }

    data.forEach(function (e) {
      if (durakKodu && String(e.SDURAKKODU) !== String(durakKodu)) return;
      const coords = wktPointToCoords(e.KOORDINAT);
      if (!coords) {
        console.warn('Geçersiz koordinat atlandı:', e);
        return;
      }
      geojson.features.push({
        type: 'Feature',
        properties: {
          SDURAKKODU: e.SDURAKKODU,
          SDURAKADI: e.SDURAKADI,
          ILCEADI: e.ILCEADI,
          SYON: e.SYON,
          AKILLI: e.AKILLI,
          FIZIKI: e.FIZIKI,
          DURAK_TIPI: e.DURAK_TIPI,
        },
        geometry: { type: 'Point', coordinates: coords },
      });
    });

    res.json(geojson);
  });
});

// Hat bilgileri (düz JSON) — ?kod=34 ile tekil hat sorgulanabilir, boşsa tüm hat listesi döner
app.get('/api/hat', (req, res) => {
  const hatKodu = req.query.kod || '';
  callSoap(WSDL_ANA_VERI, 'GetHat_json', { HatKodu: hatKodu }, res, function (result) {
    let data;
    try {
      data = JSON.parse(result.GetHat_jsonResult);
    } catch (e) {
      console.error('JSON Parse Error:', e);
      return res.status(500).json({ error: 'Geçersiz JSON verisi alındı' });
    }

    if (hatKodu) {
      data = data.filter(function (e) {
        return String(e.SHATKODU) === String(hatKodu);
      });
    }

    res.json(
      data.map(function (e) {
        return {
          SHATKODU: e.SHATKODU,
          SHATADI: e.SHATADI,
          TARIFE: e.TARIFE,
          HAT_UZUNLUGU: e.HAT_UZUNLUGU,
          SEFER_SURESI: e.SEFER_SURESI,
        };
      })
    );
  });
});

// Garaj konumları (GeoJSON)
app.get('/api/garaj', (req, res) => {
  callSoap(WSDL_ANA_VERI, 'GetGaraj_json', {}, res, function (result) {
    let geojson = { type: 'FeatureCollection', features: [] };
    let data;
    try {
      data = JSON.parse(result.GetGaraj_jsonResult);
    } catch (e) {
      console.error('JSON Parse Error:', e);
      return res.status(500).json({ error: 'Geçersiz JSON verisi alındı' });
    }

    data.forEach(function (e) {
      const coords = wktPointToCoords(e.KOORDINAT);
      if (!coords) {
        console.warn('Geçersiz koordinat atlandı:', e);
        return;
      }
      geojson.features.push({
        type: 'Feature',
        properties: {
          ID: e.ID || '',
          GARAJ_ADI: e.GARAJ_ADI || '',
          GARAJ_KODU: e.GARAJ_KODU || '',
        },
        geometry: { type: 'Point', coordinates: coords },
      });
    });

    res.json(geojson);
  });
});

// Anlık otobüs (filo) konumları (GeoJSON)
app.get('/api/filo', (req, res) => {
  callSoap(WSDL_FILO, 'GetFiloAracKonum_json', {}, res, function (result) {
    let geojson = { type: 'FeatureCollection', features: [] };
    let data;
    try {
      data = JSON.parse(result.GetFiloAracKonum_jsonResult);
    } catch (e) {
      console.error('JSON Parse Error:', e);
      return res.status(500).json({ error: 'Geçersiz JSON verisi alındı' });
    }

    data.forEach(function (e) {
      try {
        const enlem = parseFloat(String(e.Enlem).replace(' ', ''));
        const boylam = parseFloat(String(e.Boylam).replace(' ', ''));
        if (isNaN(enlem) || isNaN(boylam)) {
          console.warn('Geçersiz koordinat atlandı:', e);
          return;
        }
        geojson.features.push({
          type: 'Feature',
          properties: {
            Operator: e.Operator || '',
            Garaj: e.Garaj || '',
            KapiNo: e.KapiNo || '',
            Saat: e.Saat || '',
            Boylam: e.Boylam || '',
            Enlem: e.Enlem || '',
            hiz: e.hiz || '',
            Plaka: e.Plaka || '',
          },
          geometry: { type: 'Point', coordinates: [boylam, enlem] },
        });
      } catch (parseError) {
        console.error('Koordinat ayrıştırma hatası:', parseError, e);
      }
    });

    res.json(geojson);
  });
});

// Sefer/durak verisi (GeoJSON) — orijinal projedeki sefer.js ile aynı mantık
app.get('/api/sefer', (req, res) => {
  callSoap(WSDL_ANA_VERI, 'GetDurak_json', { DurakKodu: '' }, res, function (result) {
    let geojson = { type: 'FeatureCollection', features: [] };
    let data;
    try {
      data = JSON.parse(result.GetDurak_jsonResult);
    } catch (e) {
      console.error('JSON Parse Error:', e);
      return res.status(500).json({ error: 'Geçersiz JSON verisi alındı' });
    }

    data.forEach(function (e) {
      const coords = wktPointToCoords(e.KOORDINAT);
      if (!coords) {
        console.warn('Geçersiz koordinat atlandı:', e);
        return;
      }
      geojson.features.push({
        type: 'Feature',
        properties: {
          SDURAKKODU: e.SDURAKKODU || '',
          SDURAKADI: e.SDURAKADI || '',
          ILCEADI: e.ILCEADI || '',
          SYON: e.SYON || '',
          AKILLI: e.AKILLI || '',
          FIZIKI: e.FIZIKI || '',
          DURAK_TIPI: e.DURAK_TIPI || '',
        },
        geometry: { type: 'Point', coordinates: coords },
      });
    });

    res.json(geojson);
  });
});

// İETT'nin GetDuyurular_json servisi, sonucu düzgün bir JSON dizisi ([{...},{...}])
// olarak değil; köşeli parantez OLMADAN virgülle ayrılmış obje listesi olarak
// döndürüyor: {...},{...},{...}. Bu yüzden JSON.parse doğrudan patlıyor.
// Önce olduğu gibi parse etmeyi deniyoruz (İETT formatı düzeltirse diye),
// olmazsa köşeli parantezle sarıp tekrar deniyoruz.
function parseDuyuruJson(ham) {
  if (!ham) return [];
  const metin = String(ham).trim();
  if (!metin) return [];

  try {
    return JSON.parse(metin);
  } catch (ilkHata) {
    const sarilmis = metin.startsWith('[') ? metin : `[${metin}]`;
    return JSON.parse(sarilmis); // burada patlarsa gerçekten bozuk veri var demektir
  }
}

// İETT duyuruları (düz JSON)
app.get('/api/duyuru', (req, res) => {
  callSoap(WSDL_DUYURU, 'GetDuyurular_json', {}, res, function (result) {
    try {
      const data = parseDuyuruJson(result.GetDuyurular_jsonResult);
      res.json(data);
    } catch (e) {
      console.error('JSON Parse Error:', e);
      res.status(500).json({ error: 'Geçersiz JSON verisi alındı' });
    }
  });
});

// Tahmini varış süresi (ETA) — belirli bir hattaki araçların, verilen durağa
// kuş uçuşu mesafe ve anlık/varsayılan hıza göre tahmini varış süresi
// Örnek: /api/varis-tahmini?hat=34&durak=219802
//
// Not: Bu servis GERÇEK rota mesafesi değil, KUŞ UÇUŞU mesafe kullanır.
// Trafik, güzergahın kıvrımları ve ara duraklarda bekleme süresi hesaba
// katılmaz. Ayrıca hız bilgisi ve hat konum verisi SeferGerceklesme.asmx
// WSDL'inden geldiği için İETT'nin "saatte maksimum 100 istek" kısıtına tabidir.
app.get('/api/varis-tahmini', async (req, res) => {
  const hatKodu = req.query.hat;
  const durakKodu = req.query.durak;

  if (!hatKodu || !durakKodu) {
    return res.status(400).json({
      error: 'hat ve durak query parametreleri zorunludur. Örnek: /api/varis-tahmini?hat=34&durak=219802',
    });
  }

  const VARSAYILAN_HIZ_KMH = 18; // Hız bilgisi bulunamazsa şehir içi otobüs için varsayım

  try {
    // 1) Hedef durağın koordinatını bul
    const anaVeriClient = await soap.createClientAsync(WSDL_ANA_VERI);
    const [durakSonuc] = await anaVeriClient.GetDurak_jsonAsync({ DurakKodu: durakKodu });
    const durakListesi = JSON.parse(durakSonuc.GetDurak_jsonResult);
    const hedefDurak = durakListesi.find((d) => String(d.SDURAKKODU) === String(durakKodu));

    if (!hedefDurak) {
      return res.status(404).json({ error: 'Durak kodu bulunamadı: ' + durakKodu });
    }

    const hedefKoordinat = wktPointToCoords(hedefDurak.KOORDINAT); // [lon, lat]
    if (!hedefKoordinat) {
      return res.status(500).json({ error: 'Hedef durağın koordinatı okunamadı' });
    }
    const [hedefLon, hedefLat] = hedefKoordinat;

    // 2) Hat üzerindeki araçların anlık konumunu al
    // NOT: İETT'nin GetHatOtoKonum_json servisi bazı hat kodları için (özellikle o an
    // canlı aracı olmayan hatlarda) "Object reference not set..." şeklinde bir SOAP
    // fault dönebiliyor. Bu İETT tarafındaki bir servis kusuru; bizim tarafımızda kırılıp
    // 500 döndürmek yerine "veri yok" olarak ele alıp kullanıcıya düzgün bir yanıt veriyoruz.
    const filoClient = await soap.createClientAsync(WSDL_FILO);
    let hatOtoListesi = [];
    try {
      // NOT: Resmi PDF dokümanında parametre adı "HatNo" olarak geçiyor, ancak servis
      // gerçekte "HatKodu" parametresini bekliyor. "HatNo" gönderildiğinde sunucu null
      // reference hatası fırlatıyor — bu düzeltme olmadan hiçbir hat kodu çalışmaz.
      const [hatOtoSonuc] = await filoClient.GetHatOtoKonum_jsonAsync({ HatKodu: hatKodu });
      hatOtoListesi = JSON.parse(hatOtoSonuc.GetHatOtoKonum_jsonResult) || [];
    } catch (hatOtoErr) {
      console.error('GetHatOtoKonum_json İETT servis hatası:', hatOtoErr.message || hatOtoErr);
      return res.json({
        hat: hatKodu,
        durak: durakKodu,
        durakAdi: hedefDurak.SDURAKADI,
        araclar: [],
        not:
          'İETT\'nin canlı konum servisi (GetHatOtoKonum_json) bu hat kodu için şu anda hata döndürüyor ' +
          'veya veri yok. Bu genelde İETT tarafındaki bir servis sorunudur (bazı hat kodlarında görülüyor); ' +
          'hat kodunu /api/hat ile doğrulayıp birazdan tekrar deneyin.',
      });
    }

    if (!Array.isArray(hatOtoListesi) || hatOtoListesi.length === 0) {
      return res.json({
        hat: hatKodu,
        durak: durakKodu,
        durakAdi: hedefDurak.SDURAKADI,
        araclar: [],
        not: 'Bu hatta şu anda anlık konum verisi bulunamadı.',
      });
    }

    // 3) Hız bilgisi için genel filo konum verisiyle kapı numarasına göre eşleştir
    let filoAracListesi = [];
    try {
      const [filoAracSonuc] = await filoClient.GetFiloAracKonum_jsonAsync({});
      filoAracListesi = JSON.parse(filoAracSonuc.GetFiloAracKonum_jsonResult) || [];
    } catch (filoErr) {
      console.error('GetFiloAracKonum_json hatası (hız bilgisi olmadan devam edilecek):', filoErr.message || filoErr);
      filoAracListesi = [];
    }

    // DEBUG: gerçek alan adlarını/formatlarını görmek için ilk kayıtları konsola basıyoruz.
    // Sorun devam ederse bu logları terminalden kontrol et — İETT'nin PDF dokümanı
    // alan adları konusunda daha önce de yanılmıştı (HatNo/HatKodu örneğinde olduğu gibi).
    console.log('DEBUG hatOtoListesi[0]:', JSON.stringify(hatOtoListesi[0]));
    if (filoAracListesi[0]) {
      console.log('DEBUG filoAracListesi[0]:', JSON.stringify(filoAracListesi[0]));
    }

    // Kapı no karşılaştırmasını boşluk/büyük-küçük harf farklarına karşı normalize eden yardımcı
    const normalizeKapiNo = (deger) => String(deger || '').trim().toUpperCase().replace(/\s+/g, '');

    const hizMap = new Map();
    filoAracListesi.forEach((a) => {
      const hiz = parseFloat(String(a.hiz).replace(',', '.'));
      const kapiNoKey = normalizeKapiNo(a.KapiNo);
      if (kapiNoKey && !isNaN(hiz)) {
        hizMap.set(kapiNoKey, { hiz, plaka: a.Plaka });
      }
    });

    // Kuş uçuşu mesafe her zaman gerçek yol mesafesinden kısadır (yollar dümdüz gitmez,
    // kavşaklardan döner, tek yönlü olabilir). Bunu kabaca telafi etmek için bir katsayı
    // uyguluyoruz. Bu KESİN bir düzeltme değil, yaklaşık bir düzeltmedir.
    const ROTA_KATSAYISI = 1.4;

    // 4) Her araç için mesafe + tahmini süre hesapla
    const araclar = hatOtoListesi
      .map((arac) => {
        const boylam = parseFloat(String(arac.boylam).replace(',', '.'));
        const enlem = parseFloat(String(arac.enlem).replace(',', '.'));
        if (isNaN(boylam) || isNaN(enlem)) return null;

        const kusUcusuMetre = haversineDistance(enlem, boylam, hedefLat, hedefLon);
        const mesafeMetre = kusUcusuMetre * ROTA_KATSAYISI;
        const eslesme = hizMap.get(normalizeKapiNo(arac.kapino));
        const hizGercekMi = !!(eslesme && eslesme.hiz > 0);
        const hizKmh = hizGercekMi ? eslesme.hiz : VARSAYILAN_HIZ_KMH;
        const tahminiDakika = (mesafeMetre / 1000 / hizKmh) * 60;

        return {
          kapiNo: arac.kapino,
          plaka: eslesme ? eslesme.plaka : null,
          hatAdi: arac.hatad,
          yon: arac.yon,
          yakinDurakKodu: arac.yakinDurakKodu,
          sonKonumZamani: arac.son_konum_zamani,
          kusUcusuMesafeMetre: Math.round(kusUcusuMetre),
          mesafeMetre: Math.round(mesafeMetre),
          hizKmh: Math.round(hizKmh * 10) / 10,
          hizVarsayilanMi: !hizGercekMi,
          tahminiVarisDakika: Math.round(tahminiDakika * 10) / 10,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.mesafeMetre - b.mesafeMetre);

    res.json({
      hat: hatKodu,
      durak: durakKodu,
      durakAdi: hedefDurak.SDURAKADI,
      araclar,
      not:
        'mesafeMetre, kuş uçuşu mesafeye ~1.4 kat düzeltme uygulanarak hesaplanır (gerçek yol mesafesi ' +
        'tahmini); kusUcusuMesafeMetre ham/düzeltilmemiş değeri gösterir. hizVarsayilanMi=true ise o araç ' +
        'için gerçek hız verisi eşleşmedi, 18 km/s varsayıldı. Trafik ve ara duraklarda bekleme yine de ' +
        'hesaba katılmaz; İETT\'nin resmi uygulamasıyla tam örtüşmeyebilir.',
    });
  } catch (err) {
    console.error('Varış Tahmini Hatası:', err);
    res.status(500).json({ error: 'Varış tahmini hesaplanamadı' });
  }
});

// Bir hattaki araçların şu an hangi durağa yakın olduğu (durak adıyla birlikte)
// Örnek: /api/hat-arac-durum?hat=34
app.get('/api/hat-arac-durum', async (req, res) => {
  const hatKodu = req.query.hat;
  if (!hatKodu) {
    return res.status(400).json({ error: 'hat query parametresi zorunludur. Örnek: /api/hat-arac-durum?hat=34' });
  }

  try {
    // 1) Hattaki araçların anlık konumunu + en yakın durak kodunu al
    const filoClient = await soap.createClientAsync(WSDL_FILO);
    let araclarHam = [];
    try {
      const [hatOtoSonuc] = await filoClient.GetHatOtoKonum_jsonAsync({ HatKodu: hatKodu });
      araclarHam = JSON.parse(hatOtoSonuc.GetHatOtoKonum_jsonResult) || [];
    } catch (hatOtoErr) {
      console.error('GetHatOtoKonum_json İETT servis hatası:', hatOtoErr.message || hatOtoErr);
      return res.json({
        hat: hatKodu,
        araclar: [],
        not: 'İETT\'nin canlı konum servisi bu hat için şu anda hata döndürüyor veya veri yok.',
      });
    }

    if (!Array.isArray(araclarHam) || araclarHam.length === 0) {
      return res.json({ hat: hatKodu, araclar: [], not: 'Bu hatta şu anda anlık konum verisi bulunamadı.' });
    }

    // 2) Durak adlarını çözmek için tüm durak listesini çek (tek seferde, tüm İstanbul)
    const anaVeriClient = await soap.createClientAsync(WSDL_ANA_VERI);
    const [durakSonuc] = await anaVeriClient.GetDurak_jsonAsync({ DurakKodu: '' });
    const tumDuraklar = JSON.parse(durakSonuc.GetDurak_jsonResult) || [];
    const durakMap = new Map(tumDuraklar.map((d) => [String(d.SDURAKKODU), d]));

    const araclar = araclarHam.map((arac) => {
      const durak = durakMap.get(String(arac.yakinDurakKodu));
      return {
        kapiNo: arac.kapino,
        hatAdi: arac.hatad,
        yon: arac.yon,
        sonKonumZamani: arac.son_konum_zamani,
        yakinDurakKodu: arac.yakinDurakKodu,
        yakinDurakAdi: durak ? durak.SDURAKADI : null,
        yakinDurakIlce: durak ? durak.ILCEADI : null,
      };
    });

    res.json({
      hat: hatKodu,
      araclar,
      not: 'yakinDurakKodu/Adi, aracın koordinatına göre İETT tarafından hesaplanan en yakın duraktır; aracın o durakta durduğu anlamına gelmez.',
    });
  } catch (err) {
    console.error('Hat Araç Durum Hatası:', err);
    res.status(500).json({ error: 'Araç-durak durumu alınamadı' });
  }
});

// Bir hattın sırayla geçtiği duraklar (yön bazlı: G=Gidiş, D=Dönüş)
// Örnek: /api/hat-duraklari?hat=34
//
// DENEYSEL: Bu servis İETT'nin ibb.asmx WSDL'indeki DurakDetay_GYY metodunu kullanır.
// Resmi dokümanda bu metodun sadece "XML" döndürdüğü yazıyor ve alan adlarının doğruluğu
// bu projede daha önce (HatNo/HatKodu örneğinde) yanlış çıktı. Sonuç hem düz obje hem de
// string içinde gömülü XML olarak gelebilir; ikisini de deniyoruz. Konsoldaki DEBUG
// satırına bakıp gerçek yapıyı doğrulaman gerekebilir.
app.get('/api/hat-duraklari', async (req, res) => {
  const hatKodu = req.query.hat;
  if (!hatKodu) {
    return res.status(400).json({ error: 'hat query parametresi zorunludur. Örnek: /api/hat-duraklari?hat=34' });
  }

  try {
    const ibbClient = await soap.createClientAsync(WSDL_IBB);
    const [sonuc] = await ibbClient.DurakDetay_GYYAsync({ hat_kodu: hatKodu });

    console.log('DEBUG DurakDetay_GYY ham sonuç:', JSON.stringify(sonuc));

    let kayitlar = [];

    // Gerçek yapı: sonuc.DurakDetay_GYYResult.NewDataSet.Table -> obje dizisi
    // (node-soap WSDL'i strongly-typed olarak çözüyor, string içine gömülü XML değilmiş)
    const tabloDogrudan = sonuc?.DurakDetay_GYYResult?.NewDataSet?.Table;
    if (Array.isArray(tabloDogrudan)) {
      kayitlar = tabloDogrudan;
    } else if (tabloDogrudan && typeof tabloDogrudan === 'object') {
      // Tek durak dönerse dizi değil tek obje olarak gelebilir
      kayitlar = [tabloDogrudan];
    } else if (typeof sonuc?.DurakDetay_GYYResult === 'string' && sonuc.DurakDetay_GYYResult.trim().startsWith('<')) {
      // Yedek yol: bazı hatlarda/servis sürümlerinde string içine gömülü XML gelirse
      const parser = new xml2js.Parser({ explicitArray: false, ignoreAttrs: true });
      const parsed = await parser.parseStringPromise(sonuc.DurakDetay_GYYResult);
      const tablo = parsed?.NewDataSet?.Table || parsed?.DocumentElement?.Table || [];
      kayitlar = Array.isArray(tablo) ? tablo : [tablo];
    } else if (Array.isArray(sonuc)) {
      kayitlar = sonuc;
    }

    if (!kayitlar || kayitlar.length === 0) {
      return res.json({
        hat: hatKodu,
        duraklar: [],
        not:
          'Veri ayrıştırılamadı ya da bu hat için sonuç boş döndü. Sunucu konsolundaki ' +
          '"DEBUG DurakDetay_GYY ham sonuç" satırına bakıp yapıyı doğrulaman gerekebilir.',
      });
    }

    const duraklar = kayitlar
      .map((k) => ({
        siraNo: k.SIRANO !== undefined ? Number(k.SIRANO) : null,
        yon: k.YON || null,
        durakKodu: k.DURAKKODU || null,
        durakAdi: k.DURAKADI || null,
        ilceAdi: k.ILCEADI || null,
        koordinat:
          k.XKOORDINATI && k.YKOORDINATI
            ? { lon: parseFloat(k.XKOORDINATI), lat: parseFloat(k.YKOORDINATI) }
            : null,
      }))
      .sort((a, b) => (a.yon || '').localeCompare(b.yon || '') || (a.siraNo || 0) - (b.siraNo || 0));

    res.json({ hat: hatKodu, duraklar });
  } catch (err) {
    console.error('Hat Durakları Hatası:', err);
    res.status(500).json({ error: 'Hat durakları alınamadı', detay: err.message || String(err) });
  }
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint bulunamadı' });
});

// Hata yakalayıcı
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Sunucu hatası' });
});

app.listen(PORT, () => {
  console.log(`İBB İETT GeoJSON API http://localhost:${PORT} adresinde çalışıyor`);
});
