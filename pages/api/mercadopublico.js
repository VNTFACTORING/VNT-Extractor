// Detecta si el código tiene formato de Licitación MP (termina en -LE, -LP, -LQ, -CO, -AG, -O1, etc.)
function isLicitacionCode(ref) {
  if (!ref) return false;
  return /^\d+-\d+-[A-Z]{2}\d{2}$/.test(ref.trim()) && !ref.toUpperCase().includes('-CM');
}
 
// Detecta si es código de OC (termina en -CM)
function isOCCode(ref) {
  if (!ref) return false;
  return /^\d+-\d+-CM\d{2}$/i.test(ref.trim());
}
 
// Formatea RUT sin puntos → con puntos para la API MP (76416753-8 → 76.416.753-8)
function formatRutParaAPI(rut) {
  if (!rut) return rut;
  const parts = rut.split('-');
  if (parts.length !== 2) return rut;
  const num = parseInt(parts[0].replace(/\./g, ''), 10);
  if (isNaN(num)) return rut;
  return num.toLocaleString('es-CL') + '-' + parts[1];
}
 
// Normaliza nombre para comparación fuzzy
function normalize(s) {
  return (s || '').toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[.,\-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
 
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
 
  const { rut_deudor, razon_social_deudor, ref_oc, ref_presupuesto, ref_edp } = req.body || {};
  const ticket = process.env.MERCADOPUBLICO_TICKET;
  if (!ticket) return res.status(500).json({ error: 'Ticket MP no configurado' });
 
  const result = { org: null, licitacion: null, oc: null };
 
  // Referencias a intentar como código MP (en orden de prioridad)
  const referencias = [ref_oc, ref_presupuesto, ref_edp].filter(Boolean);
 
  try {
 
    // ── PASO 1: Buscar licitación directamente por código de referencia ──
    for (const ref of referencias) {
      if (!isLicitacionCode(ref) && !isOCCode(ref)) continue;
 
      // Si es código de OC (-CM), primero buscar la OC para obtener el código de licitación
      let codigoLicitacion = isLicitacionCode(ref) ? ref : null;
 
      if (isOCCode(ref)) {
        const ocRes = await fetch(
          `https://api.mercadopublico.cl/servicios/v1/Publico/ocmpublicas/listarocmpublicas.aspx?ticket=${ticket}&codigo=${encodeURIComponent(ref)}`
        ).catch(() => null);
        if (ocRes?.ok) {
          const ocData = await ocRes.json().catch(() => null);
          if (ocData && !ocData.Codigo) {
            const oc = Array.isArray(ocData.listaOCM) ? ocData.listaOCM[0] : ocData;
            codigoLicitacion = oc?.CodigoLicitacion || oc?.Licitacion?.CodigoExterno || null;
            result.oc = { codigo: ref, datos: oc };
          }
        }
      }
 
      // Consultar licitación por código
      if (codigoLicitacion) {
        const litRes = await fetch(
          `https://api.mercadopublico.cl/servicios/v1/Publico/Licitaciones.aspx?ticket=${ticket}&codigo=${encodeURIComponent(codigoLicitacion)}`
        ).catch(() => null);
        if (litRes?.ok) {
          const litData = await litRes.json().catch(() => null);
          const l = litData?.Listado?.[0];
          if (l) {
            result.licitacion = {
              codigo: l.CodigoExterno,
              nombre: l.Nombre,
              estado: l.Estado,
              organismo: l.Comprador?.NombreOrganismo || null,
              rut_organismo: l.Comprador?.RutUnidad || null,
              direccion: [l.Comprador?.DireccionUnidad, l.Comprador?.ComunaUnidad, l.Comprador?.RegionUnidad]
                .filter(Boolean).join(', ') || null,
              ejecutivo_compras: l.Comprador?.NombreUsuario || null,
              cargo_ejecutivo: l.Comprador?.CargoUsuario || null,
              responsable_pago: l.NombreResponsablePago?.trim() || null,
              email_pago: l.EmailResponsablePago?.trim() || null,
              responsable_contrato: l.NombreResponsableContrato?.trim() || null,
              email_contrato: l.EmailResponsableContrato?.trim() || null,
              fono_contrato: l.FonoResponsableContrato?.trim() || null,
              referencia_usada: ref,
            };
            break; // Encontrado, no seguir buscando
          }
        }
      }
    }
 
    // ── PASO 2: Buscar organismo como Comprador por nombre ──
    if (!result.org) {
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
          result.org = {
            codigo: match.CodigoEmpresa,
            nombre: match.NombreEmpresa,
            fuente: 'Organismo Público',
          };
        }
      }
    }
 
    // ── PASO 3: Fallback — buscar como Proveedor por RUT ──
    if (!result.org && rut_deudor) {
      const rutAPI = formatRutParaAPI(rut_deudor);
      const provRes = await fetch(
        `https://api.mercadopublico.cl/servicios/v1/Publico/Empresas/BuscarProveedor?rutempresaproveedor=${encodeURIComponent(rutAPI)}&ticket=${ticket}`
      ).catch(() => null);
      if (provRes?.ok) {
        const empresa = (await provRes.json().catch(() => ({}))).listaEmpresas?.[0];
        if (empresa) {
          result.org = {
            codigo: empresa.CodigoEmpresa,
            nombre: empresa.NombreEmpresa,
            fuente: 'Proveedor',
          };
        }
      }
    }
 
    // ── PASO 4: Si encontramos organismo pero no licitación, buscar licitaciones recientes ──
    if (result.org && !result.licitacion) {
      const litRecRes = await fetch(
        `https://api.mercadopublico.cl/servicios/v1/Publico/Licitaciones.aspx?ticket=${ticket}&codigoorganismo=${result.org.codigo}&estado=adjudicada`
      ).catch(() => null);
      if (litRecRes?.ok) {
        const litRecData = await litRecRes.json().catch(() => ({}));
        const licitaciones = litRecData?.Listado || [];
        // Tomar la más reciente con responsables definidos
        const conResponsable = licitaciones.find(l =>
          l.NombreResponsablePago?.trim() || l.NombreResponsableContrato?.trim()
        );
        if (conResponsable) {
          result.licitacion = {
            codigo: conResponsable.CodigoExterno,
            nombre: conResponsable.Nombre,
            estado: conResponsable.Estado,
            organismo: conResponsable.Comprador?.NombreOrganismo || result.org.nombre,
            responsable_pago: conResponsable.NombreResponsablePago?.trim() || null,
            email_pago: conResponsable.EmailResponsablePago?.trim() || null,
            responsable_contrato: conResponsable.NombreResponsableContrato?.trim() || null,
            email_contrato: conResponsable.EmailResponsableContrato?.trim() || null,
            fono_contrato: conResponsable.FonoResponsableContrato?.trim() || null,
            ejecutivo_compras: conResponsable.Comprador?.NombreUsuario || null,
            cargo_ejecutivo: conResponsable.Comprador?.CargoUsuario || null,
            nota: 'Licitación reciente del organismo (referencia no encontrada directamente)',
          };
        }
      }
    }
 
    return res.status(200).json(result);
 
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
