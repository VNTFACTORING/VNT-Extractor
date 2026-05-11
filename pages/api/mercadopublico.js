import { supabase } from '../../lib/supabase'

const TICKET = process.env.MERCADOPUBLICO_TICKET;
const BASE = 'https://api.mercadopublico.cl/servicios/v1/Publico';

async function get(url) {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function fetchHtml(url) {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

function extractContactsFromHtml(html) {
  if (!html) return {};
  function val(id) {
    var m = html.match(new RegExp(id + '[^>]*>([^<]+)'));
    var v = m ? m[1].trim() : null;
    return (v && v !== '&nbsp;' && v.length > 0) ? v : null;
  }
  return {
    responsable_pago:     val('lblFicha7NombreResponsablePago'),
    email_pago:           val('lblFicha7EmailResponsablePago'),
    responsable_contrato: val('lblFicha7NombreResponsableContrato'),
    email_contrato:       val('lblFicha7EmailResponsableContrato'),
    fono_contrato:        val('lblFicha7TelefonoResponsableContrato'),
  };
}

async function getLicit(codigo) {
  var d = await get(BASE + '/Licitaciones.aspx?ticket=' + TICKET + '&codigo=' + encodeURIComponent(codigo));
  var l = d && d.Listado && d.Listado[0];
  if (!l) return null;

  var result = {
    codigo:               l.CodigoExterno,
    nombre:               l.Nombre,
    organismo:            l.Comprador ? l.Comprador.NombreOrganismo : null,
    rut_organismo:        l.Comprador ? l.Comprador.RutUnidad : null,
    unidad:               l.Comprador ? l.Comprador.NombreUnidad : null,
    ejecutivo_compras:    l.Comprador && l.Comprador.NombreUsuario ? l.Comprador.NombreUsuario.trim() : null,
    responsable_pago:     l.NombreResponsablePago ? l.NombreResponsablePago.trim() : null,
    email_pago:           l.EmailResponsablePago ? l.EmailResponsablePago.trim() : null,
    responsable_contrato: l.NombreResponsableContrato ? l.NombreResponsableContrato.trim() : null,
    email_contrato:       l.EmailResponsableContrato ? l.EmailResponsableContrato.trim() : null,
    fono_contrato:        l.FonoResponsableContrato ? l.FonoResponsableContrato.trim() : null,
  };

  var needsWeb = !result.email_pago && !result.email_contrato && !result.fono_contrato;
  var urlActa = l.Adjudicacion && l.Adjudicacion.UrlActa ? l.Adjudicacion.UrlActa : null;

  if (needsWeb && urlActa) {
    var fichaUrl = urlActa.replace(
      'StepsProcessAward/PreviewAwardAct.aspx',
      'DetailsAcquisition.aspx'
    );
    var html = await fetchHtml(fichaUrl);
    if (html && html.length > 200000) {
      var web = extractContactsFromHtml(html);
      if (web.email_pago)           result.email_pago           = web.email_pago;
      if (web.email_contrato)       result.email_contrato       = web.email_contrato;
      if (web.fono_contrato)        result.fono_contrato        = web.fono_contrato;
      if (web.responsable_pago && !result.responsable_pago)
                                    result.responsable_pago     = web.responsable_pago;
      if (web.responsable_contrato && !result.responsable_contrato)
                                    result.responsable_contrato = web.responsable_contrato;
    }
  }

  return result;
}

var sleep = function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); };

async function buscarDesdeOC(ref) {
  var prefijo = ref.split('-')[0];
  var m = ref.match(/(\d{2})$/);
  var anio = m ? m[1] : null;
  if (!prefijo || !anio) return null;

  var sufijos = ['LE', 'LP', 'CO', 'O1'];
  var fallback = null;

  for (var si = 0; si < sufijos.length; si++) {
    for (var n = 1; n <= 5; n++) {
      await sleep(300);
      var d = await getLicit(prefijo + '-' + n + '-' + sufijos[si] + anio);
      if (d && d.responsable_pago) return d;
      if (d && d.organismo && !fallback) fallback = d;
    }
  }
  return fallback;
}

async function guardarEnSupabase(licitacion, folio, rut_deudor) {
  try {
    if (!licitacion || !licitacion.rut_organismo || !licitacion.organismo) return;

    const rut = licitacion.rut_organismo.toString().trim();
    const nombre_organismo = licitacion.organismo.trim();
    const nombre_unidad = licitacion.unidad || 'Sin unidad';

    const { data: organismo, error: errOrg } = await supabase
      .from('organismos')
      .upsert({ rut, nombre: nombre_organismo }, { onConflict: 'rut' })
      .select().single();

    if (errOrg || !organismo) return;

    const { data: unidad, error: errUni } = await supabase
      .from('unidades')
      .upsert(
        { organismo_id: organismo.id, nombre: nombre_unidad },
        { onConflict: 'organismo_id,nombre' }
      )
      .select().single();

    if (errUni || !unidad) return;

    const tieneContacto = licitacion.responsable_pago || licitacion.email_pago ||
                          licitacion.responsable_contrato || licitacion.email_contrato;
    if (!tieneContacto) return;

    // Verificar si ya existe este contacto para este folio y unidad
    if (folio) {
      const { data: existe } = await supabase
        .from('contactos')
        .select('id')
        .eq('unidad_id', unidad.id)
        .eq('folio_factura', folio)
        .limit(1)

      if (existe && existe.length > 0) return;
    }

    await supabase.from('contactos').insert({
      unidad_id:            unidad.id,
      resp_pago:            licitacion.responsable_pago || null,
      email_pago:           licitacion.email_pago || null,
      resp_contrato:        licitacion.responsable_contrato || null,
      email_contrato:       licitacion.email_contrato || null,
      fono_contrato:        licitacion.fono_contrato || null,
      ejecutivo_compras:    licitacion.ejecutivo_compras || null,
      licitacion_origen:    licitacion.nombre || null,
      codigo_licitacion:    licitacion.codigo || null,
      folio_factura:        folio || null,
      rut_deudor:           rut_deudor || null,
    });

  } catch (e) {
    console.error('Supabase save error:', e.message);
  }
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
    var razon_social_deudor = body.razon_social_deudor;
    var rut_deudor = body.rut_deudor;
    var ref_oc = body.ref_oc;
    var ref_presupuesto = body.ref_presupuesto;
    var ref_edp = body.ref_edp;
    var folio = body.folio;

    var refs = [ref_oc, ref_presupuesto, ref_edp].filter(function(x) { return !!x; });
    var licitacion = null;
    var org = null;

    for (var i = 0; i < refs.length; i++) {
      if (!/^\d+-\d+-(LE|LP|LQ|CO|O1|AG)\d{2}$/i.test(refs[i])) continue;
      var d = await getLicit(refs[i]);
      if (d) { licitacion = d; break; }
      await sleep(300);
    }

    if (!licitacion && refs.length > 0) {
      for (var j = 0; j < refs.length; j++) {
        var d2 = await buscarDesdeOC(refs[j]);
        if (d2) { licitacion = d2; break; }
      }
    }

    if (!licitacion) {
      await sleep(300);
      var comp = await get(BASE + '/Empresas/BuscarComprador?ticket=' + TICKET);
      var lista = comp && comp.listaEmpresas ? comp.listaEmpresas : [];

      function norm(s) {
        return (s || '').toUpperCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/[.,\-]/g, ' ').replace(/\s+/g, ' ').trim();
      }
      var target = norm(razon_social_deudor);
      var words = target.split(' ').filter(function(w) { return w.length > 3; });
      var match = lista.find(function(e) { return norm(e.NombreEmpresa) === target; })
        || lista.find(function(e) {
          return words.slice(0,3).every(function(w) { return norm(e.NombreEmpresa).indexOf(w) >= 0; });
        });

      if (match) {
        org = { nombre: match.NombreEmpresa, codigo: match.CodigoEmpresa };
        await sleep(300);
        var lits = await get(BASE + '/Licitaciones.aspx?ticket=' + TICKET + '&codigoorganismo=' + match.CodigoEmpresa + '&estado=adjudicada');
        var listado = lits && lits.Listado ? lits.Listado : [];
        var best = listado.find(function(l) { return (l.NombreResponsablePago || '').trim(); });
        if (best) {
          await sleep(300);
          var ld = await getLicit(best.CodigoExterno);
          if (ld) { ld.nota = 'Licitacion reciente del organismo'; licitacion = ld; }
        }
      } else if (rut_deudor) {
        var rutApi = rut_deudor;
        var parts = rut_deudor.split('-');
        if (parts.length === 2) {
          var n = parseInt(parts[0].replace(/\./g, ''), 10);
          if (!isNaN(n)) rutApi = n.toLocaleString('es-CL') + '-' + parts[1];
        }
        await sleep(300);
        var prov = await get(BASE + '/Empresas/BuscarProveedor?rutempresaproveedor=' + encodeURIComponent(rutApi) + '&ticket=' + TICKET);
        var empresa = prov && prov.listaEmpresas && prov.listaEmpresas[0];
        if (empresa) org = { nombre: empresa.NombreEmpresa, codigo: empresa.CodigoEmpresa };
      }
    }

    if (!org && licitacion && licitacion.organismo) {
      org = { nombre: licitacion.organismo };
    }

    if (licitacion) {
      guardarEnSupabase(licitacion, folio, rut_deudor);
    }

    return res.status(200).json({ org: org, licitacion: licitacion });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

export const config = {
  api: { bodyParser: { sizeLimit: '1mb' } },
};
