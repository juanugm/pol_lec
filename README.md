# Extractor de Pólizas de Seguros — API REST

API REST que recibe una póliza en PDF + documentos adicionales en texto plano, y devuelve el texto extraído de la póliza junto con los campos solicitados.

---

## Requisitos

- Node.js 18+
- Variable de entorno `ANTHROPIC_API_KEY`

## Instalación

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start
```

---

## Endpoint principal

### `POST /extraer`

**Content-Type:** `multipart/form-data`

| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `poliza_pdf` | File (PDF) | Sí | La póliza de seguros en PDF |
| `otros_documentos` | string | No | Texto plano de condiciones generales y otros docs |
| `campos` | JSON string | No | Array de campos a extraer (máx. 100) |

#### Formato de `campos`

```json
[
  { "key": "prima_neta", "label": "Prima neta" },
  { "key": "titular", "label": "Nombre del titular" },
  { "key": "fecha_inicio", "label": "Fecha de inicio de vigencia" },
  { "key": "fecha_vencimiento", "label": "Fecha de vencimiento" },
  { "key": "numero_poliza", "label": "Número de póliza" }
]
```

#### Respuesta exitosa `200 OK`

```json
{
  "texto_poliza": "PÓLIZA DE SEGURO DE VIDA\n\nNúmero de póliza: 123456...",
  "campos_extraidos": {
    "prima_neta": "1.234,56 €",
    "titular": "Juan García López",
    "fecha_inicio": "01/01/2025",
    "fecha_vencimiento": "01/01/2026",
    "numero_poliza": "123456"
  },
  "meta": {
    "campos_solicitados": 5,
    "campos_encontrados": 5,
    "duracion_ms": 3210
  }
}
```

Si un campo no se encuentra en el documento, su valor será `null`.

#### Errores

| Código | Causa |
|--------|-------|
| `400` | Falta `poliza_pdf`, JSON inválido en `campos`, o más de 100 campos |
| `500` | Error al procesar el PDF o al extraer campos |

---

## Ejemplo de llamada (curl)

```bash
curl -X POST http://localhost:3000/extraer \
  -F "poliza_pdf=@/ruta/a/poliza.pdf" \
  -F "otros_documentos=Condiciones generales... (texto plano)" \
  -F 'campos=[{"key":"prima_neta","label":"Prima neta"},{"key":"titular","label":"Titular"}]'
```

## Ejemplo de llamada (JavaScript / fetch)

```javascript
const formData = new FormData();
formData.append("poliza_pdf", pdfBlob, "poliza.pdf");
formData.append("otros_documentos", condicionesGeneralesTexto);
formData.append("campos", JSON.stringify([
  { key: "prima_neta", label: "Prima neta" },
  { key: "titular", label: "Nombre del titular" }
]));

const response = await fetch("http://localhost:3000/extraer", {
  method: "POST",
  body: formData
});

const resultado = await response.json();
console.log(resultado.texto_poliza);       // texto completo
console.log(resultado.campos_extraidos);   // { prima_neta: "1.234€", ... }
console.log(resultado.meta);               // { campos_solicitados: 2, ... }
```

---

## Arquitectura del flujo

```
Otra app
   │
   ├── poliza_pdf (PDF binario)
   ├── otros_documentos (texto plano)
   └── campos (JSON)
         │
         ▼
   POST /extraer
         │
         ├─► [Paso 1] Claude extrae texto del PDF
         │     └── texto_poliza
         │
         └─► [Paso 2] Claude extrae campos del texto consolidado
               (texto_poliza + otros_documentos)
               └── campos_extraidos
         │
         ▼
   JSON de respuesta
   {
     texto_poliza,
     campos_extraidos,
     meta
   }
```

## Health check

```
GET /health
→ { "status": "ok" }
```
