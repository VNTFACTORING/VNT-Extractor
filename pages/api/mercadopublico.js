export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
 
  const { rut_deudor, razon_social_deudor, ref_oc } = req.body || {};
  const ticket = process.env.MERCADOPUBLICO_TICKET;
 
  if (!ticket) return res.status(500).json({ error: 'Ticket MP no configurado' });
  if (!rut_deudor && !razon_social_deudor) return res.status(400).json({ error: 'Faltan datos del deudor' });
 
  const result = { org: null, oc: null };
 
  try {
    // ── 1. Buscar como Comprador (organismo público) por nombre ──
    const compradorRes = await fetch(
      `https://api.mercadopublico.cl/servicios/v1/Publico/Empresas/BuscarComprador?ticket=${ticket}`
    );
    if (compradorRes.ok) {
      const compradorData = await compradorRes.json();
      const lista = compradorData.listaEmpresas || [];
 
      // Normalizar nombre para comparación
      const normalize = (s) => (s || '').toUpperCase()
        .replace(/[.,\-_]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
 
      const nombreNorm = normalize(razon_social_deudor);
 
      // Buscar coincidencia exacta primero, luego parcial
      let match = lista.find(e => normalize(e.NombreEmpresa) === nombreNorm);
      if (!match) {
        // Tomar las primeras 3 palabras significativas del nombre
        const palabras = nombreNorm.split(' ').filter(p => p.length > 3);
        match = lista.find(e => {
          const en = normalize(e.NombreEmpresa);
          return palabras.slice(0, 3).every(p => en.includes(p));
        });
      }
 
      if (match) {
        result.org = {
          codigo: match.CodigoEmpresa,
          nombre: match.NombreEmpresa,
          fuente: 'Comprador (Organismo Público)',
        };
      }
    }
 
    // ── 2. Si no encontró como Comprador, buscar como Proveedor por RUT ──
    if (!result.org && rut_deudor) {
      // Formatear RUT con puntos para la API
      const rutConPuntos = formatRutParaAPI(rut_deudor);
      const provRes = await fetch(
        `https://api.mercadopublico.cl/servicios/v1/Publico/Empresas/BuscarProveedor?rutempresaproveedor=${rutConPuntos}&ticket=${ticket}`
      );
      if (provRes.ok) {
        const provData = await provRes.json();
        const empresa = (provData.listaEmpresas || [])[0];
        if (empresa) {
          result.org = {
            codigo: empresa.CodigoEmpresa,
            nombre: empresa.NombreEmpresa,
            fuente: 'Proveedor',
          };
        }
      }
    }
 
    // ── 3. Buscar detalle de OC si se tiene el código en formato MP ──
    if (ref_oc && isMPFormat(ref_oc)) {
      const ocRes = await fetch(
        `https://api.mercadopublico.cl/servicios/v1/Publico/ocmpublicas/listarocmpublicas.aspx?ticket=${ticket}&codigo=${encodeURIComponent(ref_oc)}`
      );
      if (ocRes.ok) {
        const ocData = await ocRes.json();
        if (!ocData.Codigo) {
          // Extraer info relevante de la OC
          const oc = Array.isArray(ocData.listaOCM) ? ocData.listaOCM[0] : ocData;
          if (oc) {
            result.oc = {
              codigo: oc.CodigoOC || ref_oc,
              nombre: oc.Nombre || null,
              estado: oc.CodigoEstado || null,
              comprador_nombre: oc.Comprador?.NombreOrganismo || null,
              comprador_unidad: oc.Comprador?.UnidadCompra || null,
              comprador_rut: oc.Comprador?.RutUnidad || null,
              responsable_nombre: oc.Comprador?.NombreResponsable || null,
              responsable_email: oc.Comprador?.MailResponsable || null,
              responsable_fono: oc.Comprador?.FonoResponsable || null,
            };
          }
        }
      }
    }
 
    return res.status(200).json(result);
 
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
 
// Formatea RUT sin puntos → con puntos para la API (ej: 76416753-8 → 76.416.753-8)
function formatRutParaAPI(rut) {
  if (!rut) return rut;
  const [num, dv] = rut.split('-');
  if (!num || !dv) return rut;
  const n = parseInt(num.replace(/\./g, ''), 10);
  if (isNaN(n)) return rut;
  return n.toLocaleString('es-CL').replace(/\./g, '.') + '-' + dv;
}
 
// Detecta si el ref_oc tiene formato Mercado Público (ej: 750-12345-CM26, 1549-38-LP26)
function isMPFormat(ref) {
  if (!ref) return false;
  return /^\d+-\d+-[A-Z]{2}\d{2}$/.test(ref.trim());
}
