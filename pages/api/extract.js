// Modelo configurable vía variable de entorno con fallback
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

// Prompt del sistema — estable, cacheable
const SYSTEM_PROMPT = `Experto en documentos tributarios chilenos (facturas, EPA, notas de débito/crédito).

EMISOR vs DEUDOR:
- EMISOR: quien emite/cobra (proveedor, contratista). RUT del encabezado.
- DEUDOR: quien recibe/paga (cliente, mandante). RUT destinatario.
- En EPA: emisor=contratista, deudor=mandante. En facturas: emisor=facturador, deudor=receptor.
- Si hay duda, confianza="baja". NUNCA intercambiar.

RUT: sin puntos, con guión y DV mayúscula. Ej: 76416753-8, 71918300-K.

VENCIMIENTO: buscar fecha explícita; si no hay, usar emisión. Formato DD/MM/YYYY.

REFERENCIAS — extraer solo el código/número, sin labels:
- ref_oc: "Orden de Compra/OC" → ej "5139-99-SE26"
- ref_presupuesto: "Presupuesto" → solo número
- ref_edp: "Estado de Pago/EDP" → solo número/id
Si no existe → null.

Responder SOLO JSON válido (sin markdown):
{"tipo_documento":"","numero_folio":"","rut_emisor":"","razon_social_emisor":"","rut_deudor":"","razon_social_deudor":"","fecha_emision":"","fecha_vencimiento":"","monto_neto":0,"iva":0,"total":0,"ref_oc":"","ref_presupuesto":"","ref_edp":"","confianza":{"rut_emisor":"alta|media|baja","rut_deudor":"alta|media|baja","monto_neto":"alta|media|baja","total":"alta|media|baja"}}

Montos: enteros sin puntos/decimales. Ausentes: null.`;

async function callAnthropic(payload, retries = 4) {
  const delays = [2000, 4000, 8000, 15000];

  for (let attempt = 0; attempt <= retries; attempt++) {
    let response;
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      // Error de red — reintentar
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, delays[attempt]));
        continue;
      }
      throw err;
    }

    // Reintentar en 429 (rate limit) y 5xx (error servidor)
    if ((response.status === 429 || response.status >= 500) && attempt < retries) {
      await new Promise(r => setTimeout(r, delays[attempt]));
      continue;
    }

    return response;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { fileData, mimeType } = req.body || {};
  if (!fileData || !mimeType) {
    return res.status(400).json({ error: 'Faltan parametros' });
  }

  const content = mimeType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileData } }
    : { type: 'image', source: { type: 'base64', media_type: mimeType, data: fileData } };

  try {
    const response = await callAnthropic({
      model: MODEL,
      max_tokens: 2048,
      // Prompt cacheado a nivel system — Anthropic cobra solo 10% en hits sucesivos
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: [content] }],
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: err.error?.message || 'Error API' });
    }

    const data = await response.json();
    const text = data.content
      .map(b => b.text || '')
      .join('')
      .replace(/```json|```/g, '')
      .trim();

    try {
      return res.status(200).json(JSON.parse(text));
    } catch {
      return res.status(422).json({ error: 'Respuesta no es JSON válido', raw: text });
    }

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

export const config = {
  api: {
    bodyParser: { sizeLimit: '20mb' },
    responseLimit: false,
  }
};
