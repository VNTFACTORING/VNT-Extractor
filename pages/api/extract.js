async function callAnthropic(payload, retries = 4) {
  const delays = [2000, 4000, 8000, 15000];
 
  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'pdfs-2024-09-25',
      },
      body: JSON.stringify(payload),
    });
 
    if (response.status === 429 && attempt < retries) {
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
 
  const prompt = `Eres experto en documentos tributarios y comerciales chilenos. Analiza el documento y extrae los campos indicados.
 
REGLAS PARA IDENTIFICAR EMISOR Y DEUDOR:
- EMISOR: quien EMITE o GENERA el documento (el que cobra o presta el servicio). Busca "Razón Social", "Proveedor", "Contratista", o el RUT en el encabezado del documento.
- DEUDOR: quien RECIBE el documento y debe pagar (el cliente o mandante). Busca "Cliente", "Mandante", "Razón Social del receptor", o el RUT destinatario.
- En Estados de Pago (EPA): el EMISOR es el contratista/proveedor, el DEUDOR es el mandante/cliente.
- En Facturas Electrónicas: el EMISOR es quien factura, el DEUDOR es el receptor de la factura.
- En Notas de Débito/Crédito: el EMISOR es quien emite la nota, el DEUDOR es el receptor.
- En Boletas: el EMISOR es el comercio, el DEUDOR puede ser null si no está identificado.
- NUNCA intercambies emisor y deudor. Si hay duda, marca confianza como "baja".
 
FORMATO DE RUT — MUY IMPORTANTE:
- Siempre sin puntos, con guión y dígito verificador.
- Formato correcto: XXXXXXXX-X (ejemplos: 76416753-8, 71918300-K, 9123456-7)
- Si el RUT en el documento tiene puntos (ej: 76.416.753-8), elimínalos: 76416753-8
- El dígito verificador puede ser número o letra K (siempre mayúscula)
 
CAMPO REFERENCIA:
- Extrae el número o código de referencia del documento si existe (orden de compra, contrato, código interno, número de pedido, etc.)
- Si hay múltiples referencias, sepáralas con " | "
- Si no hay referencia, usa null
 
CAMPO FECHA DE VENCIMIENTO:
- Busca explícitamente la fecha de vencimiento o fecha de pago del documento
- Si no existe, usa la fecha de emisión como fallback
- Formato: DD/MM/YYYY
 
Responde SOLO con JSON valido sin markdown ni texto adicional:
{"tipo_documento":"string","numero_folio":"string","rut_emisor":"XXXXXXXX-X","razon_social_emisor":"string","rut_deudor":"XXXXXXXX-X","razon_social_deudor":"string","fecha_emision":"DD/MM/YYYY","fecha_vencimiento":"DD/MM/YYYY","monto_neto":0,"iva":0,"total":0,"referencia":"string","confianza":{"rut_emisor":"alta|media|baja","rut_deudor":"alta|media|baja","monto_neto":"alta|media|baja","total":"alta|media|baja"}}
 
Montos como enteros sin puntos ni decimales. Campos no visibles = null.`;
 
  try {
    const response = await callAnthropic({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: [content, { type: 'text', text: prompt }] }],
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
