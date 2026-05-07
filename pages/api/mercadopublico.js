const TICKET = process.env.MERCADOPUBLICO_TICKET;
const BASE = 'https://api.mercadopublico.cl/servicios/v1/Publico';
 
async function get(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}
 
async function getLicit(codigo) {
  const d = await get(`${BASE}/Licitaciones.aspx?ticket=${TICKET}&codigo=${encodeURIComponent(codigo)}`);
  const l = d?.Listado?.[0];
  if (!l) return null;
  return {
    codigo:        l.CodigoExterno,
    nombre:        l.Nombre,
    organismo:     l.Comprador?.NombreOrganismo || null,
    unidad:        l.Comprador?.NombreUnidad    || null,
    ejecutivo:     (l.Comprador?.NombreUsuario  || '').trim() || null,
    resp_pago:     (l.NombreResponsablePago     || '').trim() || null,
    email_pago:    (l.EmailResponsablePago      || '').trim() || null,
    resp_contrato: (l.NombreResponsableContrato || '').trim() || null,
    email_contrato:(l.EmailResponsableContrato  || '').trim() || null,
    fono:          (l.FonoResponsableContrato   || '').trim() || null,
  };
}
 
const sleep = ms => new Promise(r => setTimeout(r, ms));
 
async function buscarDesdeOC(ref) {
  const prefijo = ref.split('-')[0];
  const anio = (ref.match(/(\d{2})$/) || [])[1];
  if (!prefijo || !anio) return null;
  const sufijos = ['LE', 'LP', 'CO', 'O1'];
  for (var si = 0; si < sufijos.length; si++) {
    for (var n = 1; n <= 5; n++) {
      await sleep(300);
      const d = await getLicit(prefijo + '-' + n + '-' + sufijos[si] + anio);
      if (d && d.resp_pago) return d;
      if (d && d.organismo) return d;
    }
  }
  return null;
}
 
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    if (!TICKET) {
      return res.status(500).json({ error: 'MERCADOPUBLICO_TICKET no configurado' });
    }
 
    var body = req.body || {};
    var rut_deudor = body.rut_deudor;
    var razon_social_deudor = body.razon_social_deudor;
    var ref_oc = body.ref_oc;
    var ref_presupuesto = body.ref_presupuesto;
    var ref_edp = body.ref_edp;
 
    var refs = [ref_oc, ref_presupuesto, ref_edp].filter(function(x) { return !!x; });
    var licitacion = null;
    var org = null;
 
    // RUTA A: referencia ya es codigo licitacion
    for (var i = 0; i < refs.length; i++) {
      var ref = refs[i];
      if (!/^\d+-\d+-(LE|LP|LQ|CO|O1|AG)\d{2}$/i.test(ref)) continue;
      var d = await getLicit(ref);
      if (d) { licitacion = d; break; }
      await sleep(300);
    }
 
    // RUTA B: buscar por prefijo OC
    if (!licitacion && refs.length > 0) {
      for (var j = 0; j < refs.length; j++) {
        var d2 = await buscarDesdeOC(refs[j]);
        if (d2) { licitacion = d2; break; }
      }
    }
 
    // RUTA C: buscar organismo por nombre
    if (!licitacion) {
      await sleep(300);
      var comp = await get(BASE + '/Empresas/BuscarComprador?ticket=' + TICKET);
      var lista = (comp && comp.listaEmpresas) ? comp.listaEmpresas : [];
      function norm(s) {
        return (s || '').toUpperCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/[.,\-]/g, ' ').replace(/\s+/g, ' ').trim();
      }
      var target = norm(razon_social_deudor);
      var words = target.split(' ').filter(function(w) { return w.length > 3; });
      var match = lista.find(function(e) { return norm(e.NombreEmpresa) === target; })
        || lista.find(function(e) { return words.slice(0,3).every(function(w) { return norm(e.NombreEmpresa).indexOf(w) >= 0; }); });
 
      if (match) {
        org = { nombre: match.NombreEmpresa, codigo: match.CodigoEmpresa };
        await sleep(300);
        var lits = await get(BASE + '/Licitaciones.aspx?ticket=' + TICKET + '&codigoorganismo=' + match.CodigoEmpresa + '&estado=adjudicada');
        var listado = (lits && lits.Listado) ? lits.Listado : [];
        var best = listado.find(function(l) { return (l.NombreResponsablePago || '').trim(); });
        if (best) {
          await sleep(300);
          var ld = await getLicit(best.CodigoExterno);
          if (ld) { ld.nota = 'Licitacion reciente del organismo'; licitacion = ld; }
        }
      }
    }
 
    if (!org && licitacion && licitacion.organismo) {
      org = { nombre: licitacion.organismo };
    }
 
    return res.status(200).json({ org: org, licitacion: licitacion });
 
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
 
export const config = {
  api: { bodyParser: { sizeLimit: '1mb' } },
};
