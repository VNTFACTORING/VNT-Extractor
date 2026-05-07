// ─── Helpers ───────────────────────────────────────────────────────────────
 
function normalize(s) {
  return (s || '').toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[.,\-_]/g, ' ').replace(/\s+/g, ' ').trim();
}
 
function formatRutParaAPI(rut) {
  if (!rut) return rut;
  const [num, dv] = rut.split('-');
  if (!dv) return rut;
  const n = parseInt(num.replace(/\./g, ''), 10);
  return isNaN(n) ? rut : n.toLocaleString('es-CL') + '-' + dv;
}
 
function isLicitacionCode(ref) {
  return /^\d+-\d+-(LE|LP|LQ|LR|CO|O1|AG|L1|L2|L3)\d{2}$/i.test((ref || '').trim());
}
 
async function apiFetch(url) {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
 
// Consulta un código de licitación y retorna datos completos
async function getLicitacionData(codigo, ticket) {
  const data = await apiFetch(
    `https://api.mercadopublico.cl/servicios/v1/Publico/Licitaciones.aspx?ticket=${ticket}&codigo=${encodeURIComponent(codigo)}`
  );
  const l = data?.Listado?.[0];
  if (!l) return null;
  return {
    codigo:               l.CodigoExterno,
    nombre:               l.Nombre,
    estado:               l.Estado,
    organismo:            l.Comprador?.NombreOrganismo   || null,
    rut_organismo:        l.Comprador?.RutUnidad         || null,
    unidad:               l.Comprador?.NombreUnidad      || null,
    direccion:            [l.Comprador?.DireccionUnidad, l.Comprador?.ComunaUnidad, l.Comprador?.RegionUnidad].filter(Boolean).join(', ') || null,
    ejecutivo_compras:    l.Comprador?.NombreUsuario?.trim() || null,
    cargo_ejecutivo:      l.Comprador?.CargoUsuario?.trim()  || null,
    responsable_pago:     l.NombreResponsablePago?.trim()    || null,
    email_pago:           l.EmailResponsablePago?.trim()     || null,
    responsable_contrato: l.NombreResponsableContrato?.trim()|| null,
    email_contrato:       l.EmailResponsableContrato?.trim() || null,
    fono_contrato:        l.FonoResponsableContrato?.trim()  || null,
  };
}
 
// RUTA B: extrae el prefijo de la OC y prueba 3030-1-LE26 ... 3030-10-LE26 en paralelo
// Solo sufijo LE (más común) y máximo 10 candidatos → ~2s total
async function buscarPorPrefijoOC(codigoOC, ticket) {
  const prefijo = codigoOC.split('-')[0];
  const anio    = codigoOC.match(/(\d{2})$/)?.[1];
  if (!prefijo || !anio) return null;
 
  const sufijos    = ['LE', 'LP', 'CO', 'O1', 'LQ'];
  const candidatos = [];
  for (let n = 1; n <= 10; n++) {
    for (const suf of sufijos) {
      candidatos.push(`${prefijo}-${n}-${suf}${anio}`);
    }
  }
 
  // Todas en paralelo — máximo 50 llamadas, ~2s
  const resultados = await Promise.all(
    candidatos.map(cod => getLicitacionData(cod, ticket))
  );
 
  // Prioridad: tiene responsable_pago > tiene organismo
  return resultados.find(r => r?.responsable_pago)
      || resultados.find(r => r?.organismo)
      || null;
}
 
// ─── Handler ──────────────────────────────────────────────────────────────
 
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
 
  const { rut_deudor, razon_social_deudor, ref_oc, ref_presupuesto, ref_edp } = req.body || {};
  const ticket = process.env.MERCADOPUBLICO_TICKET;
  if (!ticket) return res.status(500).json({ error: 'Ticket MP no configurado' });
 
  const result = { org: null, licitacion: null, ruta: [] };
  const refs   = [ref_oc, ref_presupuesto, ref_edp].filter(Boolean);
 
  // ── RUTA A + RUTA B en paralelo ──────────────────────────────────────────
  // A = refs que ya son códigos de licitación → consultar directo
  // B = refs que son OC → buscar por prefijo
  if (refs.length > 0) {
    const rutaAPromises = refs.filter(isLicitacionCode).map(r => getLicitacionData(r, ticket));
    const rutaBPromises = refs.map(r => buscarPorPrefijoOC(r, ticket));
 
    const [rutaAResults, rutaBResults] = await Promise.all([
      Promise.all(rutaAPromises),
      Promise.all(rutaBPromises),
    ]);
 
    const encontrado =
      rutaAResults.find(r => r?.responsable_pago) ||
      rutaBResults.find(r => r?.responsable_pago) ||
      rutaAResults.find(r => r?.organismo)         ||
      rutaBResults.find(r => r?.organismo)         ||
      null;
 
    if (encontrado) {
      result.licitacion = { ...encontrado };
      result.org = { nombre: encontrado.organismo, rut: encontrado.rut_organismo };
      result.ruta.push(`✓ Licitación: ${encontrado.codigo}`);
    }
  }
 
  // ── RUTA C: buscar organismo por nombre (siempre, en paralelo con A+B) ───
  if (!result.org) {
    const compData = await apiFetch(
      `https://api.mercadopublico.cl/servicios/v1/Publico/Empresas/BuscarComprador?ticket=${ticket}`
    );
    const lista    = compData?.listaEmpresas || [];
    const nomNorm  = normalize(razon_social_deudor);
    const palabras = nomNorm.split(' ').filter(p => p.length > 3);
 
    const match =
      lista.find(e => normalize(e.NombreEmpresa) === nomNorm) ||
      lista.find(e => palabras.slice(0, 3).every(p => normalize(e.NombreEmpresa).includes(p)));
 
    if (match) {
      result.org = { nombre: match.NombreEmpresa, codigo: match.CodigoEmpresa };
      result.ruta.push(`✓ Organismo (C): ${match.NombreEmpresa}`);
 
      if (!result.licitacion) {
        const litData = await apiFetch(
          `https://api.mercadopublico.cl/servicios/v1/Publico/Licitaciones.aspx?ticket=${ticket}&codigoorganismo=${match.CodigoEmpresa}&estado=adjudicada`
        );
        const conResp = (litData?.Listado || []).find(l =>
          (l.NombreResponsablePago || '').trim() || (l.NombreResponsableContrato || '').trim()
        );
        if (conResp) {
          const d = await getLicitacionData(conResp.CodigoExterno, ticket);
          if (d) {
            result.licitacion = { ...d, nota: 'Licitación reciente del organismo' };
            result.ruta.push(`✓ Licitación reciente (C): ${d.codigo}`);
          }
        }
      }
    } else if (rut_deudor) {
      const provData = await apiFetch(
        `https://api.mercadopublico.cl/servicios/v1/Publico/Empresas/BuscarProveedor?rutempresaproveedor=${encodeURIComponent(formatRutParaAPI(rut_deudor))}&ticket=${ticket}`
      );
      const empresa = provData?.listaEmpresas?.[0];
      if (empresa) {
        result.org = { nombre: empresa.NombreEmpresa, codigo: empresa.CodigoEmpresa };
        result.ruta.push(`✓ Proveedor: ${empresa.NombreEmpresa}`);
      }
    }
  }
 
  if (!result.org && result.licitacion?.organismo) {
    result.org = { nombre: result.licitacion.organismo, rut: result.licitacion.rut_organismo };
  }
 
  return res.status(200).json(result);
}
 
export const config = {
  api: { bodyParser: { sizeLimit: '1mb' }, responseLimit: false },
};

