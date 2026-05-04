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

  const prompt = 'Eres experto en documentos tributarios chilenos. Extrae los campos y responde SOLO con JSON valido sin markdown ni texto adicional: {"tipo_documento":"string","numero_folio":"string","rut_emisor":"string","razon_social_emisor":"string","rut_deudor":"string","razon_social_deudor":"string","fecha_emision":"DD/MM/YYYY","monto_neto":0,"iva":0,"total":0,"confianza":{"rut_emisor":"alta|media|baja","rut_deudor":"alta|media|baja","monto_neto":"alta|media|baja","total":"alta|media|baja"}} Montos como enteros sin puntos. Campos no visibles = null.';

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{ role: 'user', content: [content, { type: 'text', text: prompt }] }]
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: err.error?.message || 'Error API' });
    }

    const data = await response.json();
    const text = data.content.map(b => b.text || '').join('').replace(/```json|```/g, '').trim();
    return res.status(200).json(JSON.parse(text));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

export const config = {
  api: { bodyParser: { sizeLimit: '20mb' } }
};
