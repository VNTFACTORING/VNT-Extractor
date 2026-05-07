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
 
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
 
async function apiFetch(url) {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
 
function parseLicitacion(l) {
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
 
async function getLicitacionData(codigo, ticket) {
  const data = await apiFetch(
    `https://api.mercadopublico.cl/servicios/v1/Publico/Licitaciones.aspx?ticket=${ticket}&codigo=${encodeURIComponent(codigo)}`
  );
  return parseLicitacion(data?.Listado?.[0]);
}
 
// RUTA B — secuencial con delay para respetar el rate limit de MP (~3 req/s)
// Prueba PREFIX-1-LE26, PREFIX-1-LP26... PREFIX-5-LE26... hasta encontrar responsable
// Máximo ~15 llamadas, ~5 segundos
async function buscarPorPrefijoOC(codigoOC, ticket) {
  const prefijo = codigoOC.split('-')[0];
  const anio    = codigoOC.match(/(\d{2})$/)?.[1];
  if (!prefijo || !anio) return null;
 
  const sufijos = ['LE', 'LP', 'CO', 'O1', 'LQ'];
 
  for (let n = 1; n <= 5; n++) {
    for (const suf of sufijos) {
      const codigo = `${prefijo}-${n}-${suf}${anio}`;
      const data   = await getLicitacionData(codigo, ticket);
 
      if (data?.responsable_pago) return data;  // Encontrado con responsable → parar
      if (data?.organismo)        {              // Encontrado sin responsable → guardar y seguir buscando uno mejor
        await sleep(300);
        continue;
      }
      await sleep(200); // delay anti rate-limit entre llamadas
    }
  }
 
  // Si no encontramos con responsable, devolver el primero con organismo
  for (let n = 1; n <= 3; n++) {
    const data = await getLicitacionData(`${prefijo}-${n}-LE${anio}`, ticket);
    if (data?.organismo) return data;
    await sleep(200);
  }
 
  return null;
}
 
// ─── Handler ──────────────────────────────────────────────────────────────
 
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
 
  const { rut_deudor, razon_social_deudor, ref_oc, ref_presupuesto, ref_edp } = req.body || {};
  const ticket = process.env.MERCADOPUBLICO_TICKET;
  if (!ticket) return res.status(500).json({ error: 'Ticket MP no configurado' });
 
  const result = { org: null, licitacion: null, ruta: [] };
  const refs   = [ref_oc, ref_presupuesto, ref_edp].filter(Boolean);
 
  // ── RUTA A: ref ya es código de licitación → consultar directo ────────────
  for (const ref of refs) {
    if (!isLicitacionCode(ref)) continue;
    result.ruta.push(`RUTA A: ${ref}`);
    const data = await getLicitacionData(ref, ticket);
    if (data) {
      result.licitacion = data;
      result.org = { nombre: data.organismo, rut: data.rut_organismo };
      result.ruta.push(`✓ A: ${data.codigo}`);
      break;
    }
    await sleep(300);
  }
 
  // ── RUTA B: prefijo OC → buscar licitaciones secuencialmente ─────────────
  if (!result.licitacion && refs.length > 0) {
    for (const ref of refs) {
      result.ruta.push(`RUTA B: prefijo "${ref}"`);
      const data = await buscarPorPrefijoOC(ref, ticket);
      if (data) {
        result.licitacion = data;
        result.org = { nombre: data.organismo, rut: data.rut_organismo };
        result.ruta.push(`✓ B: ${data.codigo}`);
        break;
      }
    }
  }
 
  // ── RUTA C: buscar organismo por nombre del deudor ────────────────────────
  if (!result.org) {
    result.ruta.push(`RUTA C: "${razon_social_deudor}"`);
    const compData = await apiFetch(
      `https://api.mercadopublico.cl/servicios/v1/Publico/Empresas/BuscarComprador?ticket=${ticket}`
    );
    const lista   = compData?.listaEmpresas || [];
    const nomNorm = normalize(razon_social_deudor);
    const palabras = nomNorm.split(' ').filter(p => p.length > 3);
 
    const match =
      lista.find(e => normalize(e.NombreEmpresa) === nomNorm) ||
      lista.find(e => palabras.slice(0, 3).every(p => normalize(e.NombreEmpresa).includes(p)));
 
    if (match) {
      result.org = { nombre: match.NombreEmpresa, codigo: match.CodigoEmpresa };
      result.ruta.push(`✓ C org: ${match.NombreEmpresa}`);
 
      if (!result.licitacion) {
        await sleep(300);
        const litData = await apiFetch(
          `https://api.mercadopublico.cl/servicios/v1/Publico/Licitaciones.aspx?ticket=${ticket}&codigoorganismo=${match.CodigoEmpresa}&estado=adjudicada`
        );
        const conResp = (litData?.Listado || []).find(l =>
          (l.NombreResponsablePago || '').trim() || (l.NombreResponsableContrato || '').trim()
        );
        if (conResp) {
          await sleep(300);
          const d = await getLicitacionData(conResp.CodigoExterno, ticket);
          if (d) {
            result.licitacion = { ...d, nota: 'Licitación reciente del organismo' };
            result.ruta.push(`✓ C licit: ${d.codigo}`);
          }
        }
      }
    } else if (rut_deudor) {
      await sleep(300);
      const provData = await apiFetch(
        `https://api.mercadopublico.cl/servicios/v1/Publico/Empresas/BuscarProveedor?rutempresaproveedor=${encodeURIComponent(formatRutParaAPI(rut_deudor))}&ticket=${ticket}`
      );
      const empresa = provData?.listaEmpresas?.[0];
      if (empresa) {
        result.org = { nombre: empresa.NombreEmpresa, codigo: empresa.CodigoEmpresa };
        result.ruta.push(`✓ C prov: ${empresa.NombreEmpresa}`);
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
