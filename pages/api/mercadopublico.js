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
 
// Solo es licitación si termina en sufijo licitación oficial
function isLicitacionCode(ref) {
  if (!ref) return false;
  return /^\d+-\d+-(LE|LP|LQ|LR|CO|O1|AG|L1|L2|L3)\d{2}$/i.test(ref.trim());
}
 
// Fetch con timeout explícito
async function fetchTimeout(url, ms = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    return null;
  }
}
 
// Consulta un código de licitación en la API y retorna datos de responsables
async function getLicitacionData(codigo, ticket) {
  try {
    const res = await fetchTimeout(
      `https://api.mercadopublico.cl/servicios/v1/Publico/Licitaciones.aspx?ticket=${ticket}&codigo=${encodeURIComponent(codigo)}`
    );
    if (!res?.ok) return null;
    const data = await res.json();
    const l = data?.Listado?.[0];
    if (!l) return null;
    return {
      codigo: l.CodigoExterno,
      nombre: l.Nombre,
      estado: l.Estado,
      organismo: l.Comprador?.NombreOrganismo || null,
      rut_organismo: l.Comprador?.RutUnidad || null,
      unidad: l.Comprador?.NombreUnidad || null,
      direccion: [l.Comprador?.DireccionUnidad, l.Comprador?.ComunaUnidad, l.Comprador?.RegionUnidad].filter(Boolean).join(', ') || null,
      ejecutivo_compras: l.Comprador?.NombreUsuario?.trim() || null,
      cargo_ejecutivo: l.Comprador?.CargoUsuario?.trim() || null,
      responsable_pago: l.NombreResponsablePago?.trim() || null,
      email_pago: l.EmailResponsablePago?.trim() || null,
      responsable_contrato: l.NombreResponsableContrato?.trim() || null,
      email_contrato: l.EmailResponsableContrato?.trim() || null,
      fono_contrato: l.FonoResponsableContrato?.trim() || null,
    };
  } catch {
    return null;
  }
}
 
// RUTA B — sin scraping web: usa el prefijo del OC para probar licitaciones vía API
// OC: 3030-186-SE26 → prefijo=3030, año=26 → prueba 3030-1-LE26, 3030-2-LE26...
async function buscarLicitacionPorPrefijoOC(codigoOC, ticket) {
  const partes = codigoOC.split('-');
  if (partes.length < 3) return null;
 
  const prefijo = partes[0];
  const anioMatch = codigoOC.match(/(\d{2})$/);
  if (!anioMatch) return null;
  const anio = anioMatch[1];
 
  const sufijos = ['LE', 'LP', 'LQ', 'CO', 'O1', 'AG', 'L1', 'LR'];
 
  // Probar en paralelo bloques de 4 licitaciones a la vez
  for (let base = 1; base <= 20; base += 4) {
    const candidatos = [];
    for (let n = base; n < base + 4; n++) {
      for (const suf of sufijos) {
        candidatos.push(`${prefijo}-${n}-${suf}${anio}`);
      }
    }
 
    const resultados = await Promise.all(
      candidatos.map(cod => getLicitacionData(cod, ticket))
    );
 
    // Priorizar licitaciones con responsable de pago
    const conResponsable = resultados.find(r => r?.responsable_pago);
    if (conResponsable) return conResponsable;
 
    // Aceptar licitaciones que al menos tienen organismo definido
    const conOrganismo = resultados.find(r => r?.organismo);
    if (conOrganismo) return conOrganismo;
  }
 
  return null;
}
 
// ─── Handler principal ─────────────────────────────────────────────────────
 
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
 
  const { rut_deudor, razon_social_deudor, ref_oc, ref_presupuesto, ref_edp } = req.body || {};
  const ticket = process.env.MERCADOPUBLICO_TICKET;
  if (!ticket) return res.status(500).json({ error: 'Ticket MP no configurado' });
 
  const result = { org: null, licitacion: null, ruta: [] };
  const refs = [ref_oc, ref_presupuesto, ref_edp].filter(Boolean);
 
  try {
 
    // ── RUTA A: ref ES directamente un código de licitación ─────────────────
    for (const ref of refs) {
      if (!isLicitacionCode(ref)) continue;
      result.ruta.push(`RUTA A: ${ref} → consultar API directamente`);
      const data = await getLicitacionData(ref, ticket);
      if (data) {
        result.licitacion = { ...data, referencia_usada: ref };
        result.ruta.push(`✓ RUTA A exitosa: ${data.codigo}`);
        break;
      }
    }
 
    // ── RUTA B: prefijo del OC → buscar licitaciones en la API (sin scraping) ─
    if (!result.licitacion && refs.length > 0) {
      for (const ref of refs) {
        result.ruta.push(`RUTA B: buscando licitaciones desde prefijo de OC "${ref}"`);
        const data = await buscarLicitacionPorPrefijoOC(ref, ticket);
        if (data) {
          result.licitacion = { ...data, referencia_usada: ref };
          result.ruta.push(`✓ RUTA B exitosa: ${data.codigo}`);
          break;
        }
        result.ruta.push(`✗ RUTA B sin resultado para "${ref}"`);
      }
    }
 
    // ── RUTA C: buscar organismo por nombre → licitaciones recientes ─────────
    if (!result.org || !result.licitacion) {
      result.ruta.push(`RUTA C: buscando organismo "${razon_social_deudor}"`);
      const compRes = await fetchTimeout(
        `https://api.mercadopublico.cl/servicios/v1/Publico/Empresas/BuscarComprador?ticket=${ticket}`,
        7000
      );
      if (compRes?.ok) {
        const lista = (await compRes.json()).listaEmpresas || [];
        const nomNorm = normalize(razon_social_deudor);
        const palabras = nomNorm.split(' ').filter(p => p.length > 3);
        let match = lista.find(e => normalize(e.NombreEmpresa) === nomNorm);
        if (!match && palabras.length >= 2) {
          match = lista.find(e => palabras.slice(0, 3).every(p => normalize(e.NombreEmpresa).includes(p)));
        }
        if (match) {
          result.org = { nombre: match.NombreEmpresa, codigo: match.CodigoEmpresa };
          result.ruta.push(`✓ Organismo: ${match.NombreEmpresa} (${match.CodigoEmpresa})`);
 
          if (!result.licitacion) {
            const litRes = await fetchTimeout(
              `https://api.mercadopublico.cl/servicios/v1/Publico/Licitaciones.aspx?ticket=${ticket}&codigoorganismo=${match.CodigoEmpresa}&estado=adjudicada`,
              6000
            );
            if (litRes?.ok) {
              const listado = (await litRes.json()).Listado || [];
              const conResp = listado.find(l => (l.NombreResponsablePago || '').trim() || (l.NombreResponsableContrato || '').trim());
              if (conResp) {
                const data = await getLicitacionData(conResp.CodigoExterno, ticket);
                if (data) {
                  result.licitacion = { ...data, nota: 'Licitación reciente del organismo' };
                  result.ruta.push(`✓ Licitación reciente: ${data.codigo}`);
                }
              }
            }
          }
        } else {
          result.ruta.push(`✗ Organismo no encontrado, probando por RUT`);
          if (rut_deudor) {
            const provRes = await fetchTimeout(
              `https://api.mercadopublico.cl/servicios/v1/Publico/Empresas/BuscarProveedor?rutempresaproveedor=${encodeURIComponent(formatRutParaAPI(rut_deudor))}&ticket=${ticket}`,
              5000
            );
            if (provRes?.ok) {
              const empresa = (await provRes.json()).listaEmpresas?.[0];
              if (empresa) {
                result.org = { nombre: empresa.NombreEmpresa, codigo: empresa.CodigoEmpresa };
                result.ruta.push(`✓ Encontrado como proveedor: ${empresa.NombreEmpresa}`);
              }
            }
          }
        }
      }
    }
 
    // Asegurar org desde licitación si no se encontró por otro lado
    if (!result.org && result.licitacion?.organismo) {
      result.org = { nombre: result.licitacion.organismo, rut: result.licitacion.rut_organismo };
    }
 
    return res.status(200).json(result);
 
  } catch (err) {
    return res.status(500).json({ error: err.message, ruta: result.ruta });
  }
}
 
export const config = {
  api: { bodyParser: { sizeLimit: '1mb' }, responseLimit: false },
  maxDuration: 30,
};
