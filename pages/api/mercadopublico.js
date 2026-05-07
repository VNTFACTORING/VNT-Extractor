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
 
// Solo es licitacion si termina en sufijos que NO son OC (-CM) ni SE/otros internos
function isLicitacionCode(ref) {
  if (!ref) return false;
  return /^\d+-\d+-(LE|LP|LQ|LR|CO|O1|AG|L1|L2|L3)\d{2}$/i.test(ref.trim());
}
 
// Fetch con timeout explícito
async function fetchTimeout(url, options = {}, ms = 7000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}
 
// Scrape detalle OC → extrae código de licitación
async function getLicitacionDesdeOC(codigoOC) {
  try {
    const url = `https://www.mercadopublico.cl/PurchaseOrder/Modules/PO/DetailsPurchaseOrder.aspx?codigoOC=${encodeURIComponent(codigoOC)}`;
    const res = await fetchTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VanTrust/1.0)' } }, 7000);
    if (!res.ok) return null;
    const html = await res.text();
    // Página "OC no encontrada" tiene ~52KB — página válida tiene ~60KB+
    if (html.length < 56000) return null;
 
    const allCodes = [...html.matchAll(/\d+-\d+-[A-Z]{2}\d{2}/g)].map(m => m[0]);
    const unique = [...new Set(allCodes)].filter(c => c !== codigoOC);
 
    // Priorizar códigos de licitación conocidos
    return unique.find(c => /-(LE|LP|LQ|LR|CO|O1|AG|L1|L2|L3)\d{2}$/i.test(c))
      || unique[0]
      || null;
  } catch {
    return null;
  }
}
 
// Consulta API licitaciones
async function getLicitacionData(codigoLit, ticket) {
  try {
    const url = `https://api.mercadopublico.cl/servicios/v1/Publico/Licitaciones.aspx?ticket=${ticket}&codigo=${encodeURIComponent(codigoLit)}`;
    const res = await fetchTimeout(url, {}, 6000);
    if (!res.ok) return null;
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
 
// ─── Handler principal ─────────────────────────────────────────────────────
 
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
 
  const { rut_deudor, razon_social_deudor, ref_oc, ref_presupuesto, ref_edp } = req.body || {};
  const ticket = process.env.MERCADOPUBLICO_TICKET;
  if (!ticket) return res.status(500).json({ error: 'Ticket MP no configurado' });
 
  const result = { org: null, licitacion: null, ruta: [] };
  const refs = [ref_oc, ref_presupuesto, ref_edp].filter(Boolean);
 
  try {
 
    // ── RUTA A + B en paralelo por cada referencia ──────────────────────────
    // A: si la ref ya ES un código de licitación → consultar directamente
    // B: si no → scrapear OC detail → obtener código licitación → consultar
    if (refs.length > 0 && !result.licitacion) {
      for (const ref of refs) {
        let codigoLit = null;
 
        if (isLicitacionCode(ref)) {
          // RUTA A: la referencia ya es una licitación
          codigoLit = ref;
          result.ruta.push(`RUTA A: ${ref} es licitación directa`);
        } else {
          // RUTA B: scrape OC web para obtener la licitación
          result.ruta.push(`RUTA B: scrapeando OC ${ref}`);
          codigoLit = await getLicitacionDesdeOC(ref);
          if (codigoLit) result.ruta.push(`RUTA B: licitación extraída → ${codigoLit}`);
          else result.ruta.push(`RUTA B: OC no encontrada en web MP`);
        }
 
        if (codigoLit) {
          const litData = await getLicitacionData(codigoLit, ticket);
          if (litData) {
            result.licitacion = { ...litData, referencia_usada: ref, licitacion_codigo: codigoLit };
            result.ruta.push(`✓ Licitación encontrada: ${litData.codigo}`);
            // Org desde licitación
            if (litData.organismo) {
              result.org = { nombre: litData.organismo, rut: litData.rut_organismo, codigo: null };
            }
            break;
          } else {
            result.ruta.push(`✗ Licitación ${codigoLit} no retorna datos en API`);
          }
        }
      }
    }
 
    // ── RUTA C: buscar organismo por nombre → siempre se ejecuta si no hay org ──
    if (!result.org) {
      result.ruta.push(`RUTA C: buscando organismo por nombre "${razon_social_deudor}"`);
      try {
        const compradorRes = await fetchTimeout(
          `https://api.mercadopublico.cl/servicios/v1/Publico/Empresas/BuscarComprador?ticket=${ticket}`,
          {}, 7000
        );
        if (compradorRes.ok) {
          const lista = (await compradorRes.json()).listaEmpresas || [];
          const nombreNorm = normalize(razon_social_deudor);
          const palabras = nombreNorm.split(' ').filter(p => p.length > 3);
 
          let match = lista.find(e => normalize(e.NombreEmpresa) === nombreNorm);
          if (!match && palabras.length >= 2) {
            match = lista.find(e => {
              const en = normalize(e.NombreEmpresa);
              return palabras.slice(0, 3).every(p => en.includes(p));
            });
          }
 
          if (match) {
            result.org = { nombre: match.NombreEmpresa, codigo: match.CodigoEmpresa };
            result.ruta.push(`✓ Organismo encontrado: ${match.NombreEmpresa} (${match.CodigoEmpresa})`);
 
            // Solo buscar licitaciones del org si aún no tenemos licitación
            if (!result.licitacion) {
              const litOrgRes = await fetchTimeout(
                `https://api.mercadopublico.cl/servicios/v1/Publico/Licitaciones.aspx?ticket=${ticket}&codigoorganismo=${match.CodigoEmpresa}&estado=adjudicada`,
                {}, 6000
              );
              if (litOrgRes.ok) {
                const listado = (await litOrgRes.json()).Listado || [];
                const conResp = listado.find(l =>
                  (l.NombreResponsablePago || '').trim() || (l.NombreResponsableContrato || '').trim()
                );
                if (conResp) {
                  const litData = await getLicitacionData(conResp.CodigoExterno, ticket);
                  if (litData) {
                    result.licitacion = { ...litData, nota: 'Licitación reciente del organismo' };
                    result.ruta.push(`✓ Licitación reciente: ${litData.codigo}`);
                  }
                } else {
                  result.ruta.push(`✗ Organismo sin licitaciones con responsable registrado`);
                }
              }
            }
          } else {
            result.ruta.push(`✗ Organismo no encontrado en lista MP`);
            // Fallback: buscar como proveedor por RUT
            if (rut_deudor) {
              const rutAPI = formatRutParaAPI(rut_deudor);
              const provRes = await fetchTimeout(
                `https://api.mercadopublico.cl/servicios/v1/Publico/Empresas/BuscarProveedor?rutempresaproveedor=${encodeURIComponent(rutAPI)}&ticket=${ticket}`,
                {}, 5000
              );
              if (provRes.ok) {
                const empresa = (await provRes.json()).listaEmpresas?.[0];
                if (empresa) {
                  result.org = { nombre: empresa.NombreEmpresa, codigo: empresa.CodigoEmpresa, fuente: 'Proveedor' };
                  result.ruta.push(`✓ Encontrado como proveedor: ${empresa.NombreEmpresa}`);
                }
              }
            }
          }
        }
      } catch (e) {
        result.ruta.push(`✗ RUTA C error: ${e.message}`);
      }
    }
 
    return res.status(200).json(result);
 
  } catch (err) {
    return res.status(500).json({ error: err.message, ruta: result.ruta });
  }
}
 
export const config = {
  api: {
    bodyParser: { sizeLimit: '1mb' },
    responseLimit: false,
  },
  maxDuration: 30,  // Vercel Pro/hobby: extender a 30s
};
