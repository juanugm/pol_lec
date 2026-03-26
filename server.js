import express from "express";
import multer from "multer";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ── Autenticación por API key ─────────────────────────────────────────────────
const requireApiKey = (req, res, next) => {
  const expectedKey = process.env.API_KEY;
  if (!expectedKey) return next();
  const receivedKey = req.headers["x-api-key"];
  if (!receivedKey || receivedKey !== expectedKey) {
    return res.status(401).json({ error: "API key inválida o ausente. Envía el header: x-api-key" });
  }
  next();
};

app.use(express.json({ limit: "10mb" }));

// ── POST /extraer ─────────────────────────────────────────────────────────────
app.post("/extraer", requireApiKey, upload.single("poliza_pdf"), async (req, res) => {
  const start = Date.now();

  if (!req.file) {
    return res.status(400).json({ error: "Falta el campo 'poliza_pdf' (archivo PDF)." });
  }
  if (req.file.mimetype !== "application/pdf") {
    return res.status(400).json({ error: "El archivo debe ser un PDF." });
  }

  let campos = [];
  if (req.body.campos) {
    try {
      campos = JSON.parse(req.body.campos);
      if (!Array.isArray(campos)) throw new Error("'campos' debe ser un array JSON.");
      if (campos.length > 100) {
        return res.status(400).json({ error: "Máximo 100 campos por solicitud." });
      }
    } catch (e) {
      return res.status(400).json({ error: "JSON inválido en 'campos': " + e.message });
    }
  }

  const otrosTexto = (req.body.otros_documentos || "").trim();

  // ── Paso 1: Extraer texto del PDF ───────────────────────────────────────────
  let texto_poliza = "";
  try {
    const pdfBase64 = req.file.buffer.toString("base64");

    const paso1 = await client.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 8000,
      system:
        "Eres un extractor de texto especializado en pólizas de seguros. " +
        "Extrae el texto completo del PDF manteniendo la estructura: " +
        "secciones, cláusulas, tablas y valores numéricos. " +
        "Devuelve SOLO el texto extraído. Sin comentarios, sin explicaciones.",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: pdfBase64 },
            },
            { type: "text", text: "Extrae el texto completo de esta póliza de seguros." },
          ],
        },
      ],
    });

    texto_poliza = paso1.content.map((b) => b.text || "").join("").trim();

    if (!texto_poliza) {
      return res.status(422).json({
        error: "No se pudo extraer texto del PDF. Verifica que no sea una imagen escaneada sin OCR.",
      });
    }
  } catch (e) {
    return res.status(500).json({ error: "Error en extracción de PDF: " + e.message });
  }

  // ── Paso 2: Extraer campos ───────────────────────────────────────────────────
  let campos_extraidos = {};

  if (campos.length > 0) {
    const textoConsolidado =
      "=== PÓLIZA ===\n" +
      texto_poliza +
      (otrosTexto ? "\n\n=== OTROS DOCUMENTOS ===\n" + otrosTexto : "");

    const camposList = campos
      .map((c) => `- key: "${c.key || c.id}", descripción: "${c.label || c.nombre || c.name || c.key}"`)
      .join("\n");

    try {
      const paso2 = await client.messages.create({
        model: "claude-opus-4-5",
        max_tokens: 8000,
        system:
          "Eres un extractor de datos de pólizas de seguros. " +
          "Responde ÚNICAMENTE con un objeto JSON válido. " +
          "Sin markdown, sin backticks, sin texto adicional antes o después.",
        messages: [
          {
            role: "user",
            content:
              `Extrae los siguientes campos del texto de la póliza:\n\n${camposList}\n\n` +
              `Reglas:\n` +
              `- Usa exactamente los keys indicados.\n` +
              `- Si encuentras el valor, devuélvelo tal como aparece en el documento.\n` +
              `- Si no encuentras el valor, usa null.\n` +
              `- Para importes incluye la moneda si aparece.\n` +
              `- Para fechas mantén el formato original.\n\n` +
              `Texto:\n\n${textoConsolidado}`,
          },
        ],
      });

      const raw = paso2.content.map((b) => b.text || "").join("").trim();
      const cleaned = raw
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

      try {
        campos_extraidos = JSON.parse(cleaned);
      } catch {
        return res.status(500).json({
          error: "La respuesta de Claude no era JSON válido.",
          raw_response: raw,
        });
      }
    } catch (e) {
      return res.status(500).json({ error: "Error en extracción de campos: " + e.message });
    }
  }

  // ── Respuesta ───────────────────────────────────────────────────────────────
  const campos_encontrados = Object.values(campos_extraidos).filter(
    (v) => v !== null && v !== undefined && v !== ""
  ).length;

  return res.json({
    texto_poliza,
    campos_extraidos,
    meta: {
      campos_solicitados: campos.length,
      campos_encontrados,
      duracion_ms: Date.now() - start,
    },
  });
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_req, res) =>
  res.json({ status: "ok", timestamp: new Date().toISOString() })
);

// ── Arranque ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Extractor de pólizas corriendo en puerto ${PORT}`);
  console.log(`API Key configurada: ${process.env.API_KEY ? "sí" : "no (endpoint abierto)"}`);
});
