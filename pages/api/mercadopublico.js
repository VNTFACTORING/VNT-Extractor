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
 
// Detecta si es código de licitación MP (ej: 3030-1-LE26, 704093-14-LE26)
function isLicitacionCode(ref) {
  if (!ref) return false;
  return /^\d+-\d+-[A-Z]{2}\d{2}$/.test(ref.trim()) && !/CM\d{2}$/i.test(ref);
}
 
// Extrae el código de licitación desde la página de detalle de la OC en mercadopublico.cl
async function getLicitacionDesdeOC(codigoOC) {
  try {
    const url = `https://www.mercadopublico.cl/PurchaseOrder/Modules/PO/DetailsPurchaseOrder.aspx?codigoOC=${encodeURIComponent(codigoOC)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VanTrust/1.0)' }
    });
    if (!res.ok) return null;
    const html = await res.text();
 
    // Buscar todos los patrones código MP en el HTML, excluir la OC misma
    const matches = [...html.matchAll(/\d+-\d+-[A-Z]{2}\d{2}/g)]
      .map(m => m[0])
      .filter(c => c !== codigoOC && !/SE\d{2}$/i.test(c)); // excluir la OC misma y otros SE
 
    // Priorizar licitaciones (-LE, -LP, -LQ, -CO, -O1, -AG)
    const licitacion = matches.find(c => /-(LE|LP|LQ|CO|O1|AG|L1)\d{2}$/i.test(c))
      || matches[0]
      || null;
 
    return licitacion;
  } catch {
    return null;
  }
}
 
// Consulta la API de licitaciones y retorna los datos de responsables
async function getLicitacionData(codigoLicitacion, ticket) {
  try {
    const url = `https://api.mercadopublico.cl/servicios/v1/Publico/Licitaciones.aspx?ticket=${ticket}&codigo=${encodeURIComponent(codigoLicitacion)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const l = data?.Listado?.[0];
    if (!l) return null;
 
    return {
      codigo: l.CodigoExterno,
      nombre: l.Nombre,
      estado: l.Estado,
      descripcion: l.Descripcion || null,
      monto_estimado: l.MontoEstimado || null,
      plazo_pago: l.TipoPago === '1' ? '30 días contra recepción conforme' : null,
      organismo: l.Comprador?.NombreOrganismo || null,
      unidad: l.Comprador?.NombreUnidad || null,
      rut_organismo: l.Comprador?.RutUnidad || null,
      direccion: [l.Comprador?.DireccionUnidad, l.Comprador?.ComunaUnidad, l.Comprador?.RegionUnidad]
        .filter(Boolean).join(', ') || null,
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
 
  const result = {
    org: null,
    licitacion: null,
    ruta: [],   // log del camino tomado para debug
  };
 
  const referencias = [ref_oc, ref_presupuesto, ref_edp].filter(Boolean);
 
  try {
 
    // ── RUTA A: Referencia es directamente un código de licitación ──────────
    for (const ref of referencias) {
      if (!isLicitacionCode(ref)) continue;
 
      result.ruta.push(`Referencia ${ref} detectada como licitación → consultar API`);
      const litData = await getLicitacionData(ref, ticket);
      if (litData) {
        result.licitacion = { ...litData, referencia_usada: ref };
        result.ruta.push(`✓ Licitación encontrada directamente: ${litData.codigo}`);
        break;
      }
    }
 
    // ── RUTA B: Scrape OC detail → extraer código licitación → API ──────────
    if (!result.licitacion) {
      for (const ref of referencias) {
        result.ruta.push(`Buscando licitación desde OC web: ${ref}`);
        const codigoLit = await getLicitacionDesdeOC(ref);
 
        if (codigoLit) {
          result.ruta.push(`✓ Licitación extraída de OC web: ${codigoLit}`);
          const litData = await getLicitacionData(codigoLit, ticket);
          if (litData) {
            result.licitacion = { ...litData, referencia_usada: ref, licitacion_desde_oc: codigoLit };
            result.ruta.push(`✓ Datos obtenidos de licitación ${litData.codigo}`);
            break;
          }
        } else {
          result.ruta.push(`✗ No se encontró licitación para OC ${ref}`);
        }
      }
    }
 
    // ── RUTA C: Buscar organismo por nombre → licitaciones recientes ─────────
    if (!result.licitacion || !result.org) {
      result.ruta.push('Buscando organismo por nombre en MP...');
      const compradorRes = await fetch(
        `https://api.mercadopublico.cl/servicios/v1/Publico/Empresas/BuscarComprador?ticket=${ticket}`
      ).catch(() => null);
 
      if (compradorRes?.ok) {
        const lista = (await compradorRes.json().catch(() => ({}))).listaEmpresas || [];
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
          result.org = { codigo: match.CodigoEmpresa, nombre: match.NombreEmpresa };
          result.ruta.push(`✓ Organismo encontrado: ${match.NombreEmpresa} (${match.CodigoEmpresa})`);
 
          // Si aún no tenemos licitación, buscar la más reciente del organismo
          if (!result.licitacion) {
            const litRecRes = await fetch(
              `https://api.mercadopublico.cl/servicios/v1/Publico/Licitaciones.aspx?ticket=${ticket}&codigoorganismo=${match.CodigoEmpresa}&estado=adjudicada`
            ).catch(() => null);
 
            if (litRecRes?.ok) {
              const listado = (await litRecRes.json().catch(() => ({}))).Listado || [];
              const conResp = listado.find(l =>
                (l.NombreResponsablePago || '').trim() || (l.NombreResponsableContrato || '').trim()
              );
              if (conResp) {
                const litData = await getLicitacionData(conResp.CodigoExterno, ticket);
                if (litData) {
                  result.licitacion = {
                    ...litData,
                    nota: 'Licitación reciente del organismo (sin match directo con OC)',
                  };
                  result.ruta.push(`✓ Licitación reciente encontrada: ${litData.codigo}`);
                }
              } else {
                result.ruta.push('✗ No hay licitaciones con responsable definido para este organismo');
              }
            }
          }
        } else {
          result.ruta.push(`✗ Organismo no encontrado en MP: ${razon_social_deudor}`);
          // Fallback: buscar como proveedor por RUT
          if (rut_deudor) {
            const rutAPI = formatRutParaAPI(rut_deudor);
            const provRes = await fetch(
              `https://api.mercadopublico.cl/servicios/v1/Publico/Empresas/BuscarProveedor?rutempresaproveedor=${encodeURIComponent(rutAPI)}&ticket=${ticket}`
            ).catch(() => null);
            if (provRes?.ok) {
              const empresa = (await provRes.json().catch(() => ({}))).listaEmpresas?.[0];
              if (empresa) {
                result.org = { codigo: empresa.CodigoEmpresa, nombre: empresa.NombreEmpresa, fuente: 'Proveedor' };
                result.ruta.push(`✓ Encontrado como proveedor: ${empresa.NombreEmpresa}`);
              }
            }
          }
        }
      }
    }
 
    // Asegurar que org siempre tenga datos si tenemos licitación
    if (!result.org && result.licitacion?.organismo) {
      result.org = { nombre: result.licitacion.organismo, rut: result.licitacion.rut_organismo };
    }
 
    return res.status(200).json(result);
 
  } catch (err) {
    return res.status(500).json({ error: err.message, ruta: result.ruta });
  }
}
