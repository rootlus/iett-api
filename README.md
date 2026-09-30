# Kurulum:
```bash
npm init -y
npm install express cors soap xml2js
```
 
 # Çalıştırma:
 ```bash
node server.js
 ```
 (varsayılan port 3000, "PORT" .env değişkeniyle değiştirilebilir)

# Endpointler:
| Metot | Endpoint | Açıklama |
|---|---|---|
| `GET` | `/` | API bilgisi (sağlık kontrolü) |
| `GET` | `/api/durak?kod=` | Durak konumları (GeoJSON). `?kod=` ile tekil durak filtrelenebilir |
| `GET` | `/api/garaj` | Garaj konumları (GeoJSON) |
| `GET` | `/api/filo` | Anlık otobüs konumları (GeoJSON) |
| `GET` | `/api/sefer` | Sefer/durak verisi (GeoJSON) — `durak.js` ile aynı SOAP metodunu kullanır |
| `GET` | `/api/duyuru` | İETT duyuruları (düz JSON) |

**Not**: SOAP servisleri her gece 00:15'ten sonra kapanıyor ve durak sayısı fazla olduğu için yanıt süresi normalden uzun olabiliyor.
