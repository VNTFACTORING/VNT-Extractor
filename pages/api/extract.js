// Modelo configurable vía variable de entorno con fallback
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
 
// Prompt del sistema — estable, cacheable
const SYSTEM_PROMPT = `Experto en documentos tributarios chilenos.
 
PASO 1 — IDENTIFICAR TIPO DE DOCUMENTO:
¿Es una Factura Electrónica, Factura No Electrónica, Nota de Débito, Nota de Crédito o Estado de Pago (EPA)?
- SÍ → continuar al PASO 2
- NO → responder INMEDIATAMENTE SOLO con esto y nada más:
{"tipo_invalido":true,"tipo_documento":"[tipo exacto detectado]","codigo_respaldo":"[código/número principal del documento]"}
 
DOCUMENTOS QUE DEBEN DEVOLVER tipo_invalido=true (lista no exhaustiva):
Orden de Compra, OC, Cotización, Presupuesto, Contrato, Boleta, Guía de Despacho, Acta, Resolución, Decreto, Convenio, Certificado, Informe, Estado de Pago (EDP como documento separado).
 
PASO 2 — EXTRAER DATOS (solo para documentos válidos):
 
EMISOR vs DEUDOR:
- EMISOR: quien emite/cobra (proveedor, contratista). RUT del encabezado.
- DEUDOR: quien recibe/paga (cliente, mandante). RUT destinatario.
- En EPA: emisor=contratista, deudor=mandante. En facturas: emisor=facturador, deudor=receptor.
- Si hay duda, confianza="baja". NUNCA intercambiar.
 
RUT: sin puntos, con guión y DV mayúscula. Ej: 76416753-8, 71918300-K.
VENCIMIENTO: buscar fecha explícita; si no hay, usar emisión. Formato DD/MM/YYYY.
 
REFERENCIAS — extraer solo el código/número, sin labels. Buscar en sección "Referencias" y en texto libre:
- ref_oc: labels "Orden de Compra", "OC", "O/C" → ej "5139-99-SE26"
- ref_presupuesto: labels "Presupuesto", "Pres" → solo número
- ref_edp: labels "Estado de Pago", "EDP", "EP" → solo número/id
- ref_hes: labels "Hoja Entrada Servicio", "HES", "Entrada de Mercancía", "EM", "Vale de Entrada", "Entrada de mercancia" → ej "5000372384"
- ref_contrato: labels "Contrato", "N° Contrato", "Nº Contrato", "Contrato N°", "CPS", "N° Servicio" → ej "CPS-N64-D08-25-010"
- ref_nota_pedido: labels "Nota de Pedido", "NP", "N/P", "Pedido" → solo número/código
Si no existe → null. Una factura puede tener múltiples referencias simultáneas.
 
Responder SOLO JSON válido (sin markdown):
{"tipo_documento":"","numero_folio":"","rut_emisor":"","razon_social_emisor":"","rut_deudor":"","razon_social_deudor":"","fecha_emision":"","fecha_vencimiento":"","monto_neto":0,"iva":0,"total":0,"ref_oc":"","ref_presupuesto":"","ref_edp":"","ref_hes":"","ref_contrato":"","ref_nota_pedido":"","confianza":{"rut_emisor":"alta|media|baja","rut_deudor":"alta|media|baja","monto_neto":"alta|media|baja","total":"alta|media|baja"}}
 
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
      const parsed = JSON.parse(text);
 
      // Filtro de seguridad — si Claude clasificó como documento de respaldo
      // pero no devolvió tipo_invalido, forzarlo
      if (!parsed.tipo_invalido && parsed.tipo_documento) {
        const tipo = parsed.tipo_documento.toLowerCase();
        const esRespaldo = ['orden de compra', 'orden compra', ' oc ', 'cotizacion', 'cotización',
          'presupuesto', 'contrato', 'guia de despacho', 'guía de despacho',
          'acta', 'resolucion', 'resolución', 'decreto', 'convenio', 'certificado'
        ].some(t => tipo.includes(t));
        if (esRespaldo) {
          parsed.tipo_invalido = true;
          parsed.codigo_respaldo = parsed.numero_folio || null;
        }
      }
 
      return res.status(200).json(parsed);
    } catch (parseErr) {
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
