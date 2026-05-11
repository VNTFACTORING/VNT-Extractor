import { supabase } from '../../lib/supabase'

export default async function handler(req, res) {
  if (req.method === 'POST') {
    const { rut_organismo, nombre_organismo, nombre_unidad, contacto } = req.body
    try {
      let { data: organismo, error: errOrg } = await supabase
        .from('organismos')
        .upsert({ rut: rut_organismo, nombre: nombre_organismo }, { onConflict: 'rut' })
        .select().single()
      if (errOrg) throw errOrg

      let { data: unidad, error: errUni } = await supabase
        .from('unidades')
        .upsert({ organismo_id: organismo.id, nombre: nombre_unidad }, { onConflict: 'organismo_id,nombre' })
        .select().single()
      if (errUni) throw errUni

      const { error: errCon } = await supabase.from('contactos').insert({
        unidad_id: unidad.id,
        resp_pago: contacto.resp_pago,
        email_pago: contacto.email_pago,
        resp_contrato: contacto.resp_contrato,
        email_contrato: contacto.email_contrato,
        fono_contrato: contacto.fono_contrato,
        ejecutivo_compras: contacto.ejecutivo_compras,
        licitacion_origen: contacto.licitacion_origen,
        codigo_licitacion: contacto.codigo_licitacion,
        folio_factura: contacto.folio_factura,
      })
      if (errCon) throw errCon
      return res.status(200).json({ ok: true })
    } catch (e) {
      return res.status(500).json({ error: e.message })
    }
  }

  if (req.method === 'GET') {
    const { q } = req.query
    if (!q) return res.status(400).json({ error: 'Falta parámetro q' })

    try {
      const esNumero = /^\d+$/.test(q.trim())
      let data, error

      if (esNumero) {
        const { data: porFolio } = await supabase
          .from('contactos')
          .select('unidad_id, unidades(organismo_id)')
          .eq('folio_factura', q.trim())

        const organismoIds = porFolio
          ? [...new Set(porFolio.map(c => c.unidades?.organismo_id).filter(Boolean))]
          : []

        if (organismoIds.length > 0) {
          const result = await supabase
            .from('organismos')
            .select(`
              id, rut, nombre,
              unidades (
                id, nombre,
                contactos (
                  resp_pago, email_pago,
                  resp_contrato, email_contrato,
                  fono_contrato, ejecutivo_compras,
                  licitacion_origen, codigo_licitacion,
                  folio_factura, found_at
                )
              )
            `)
            .in('id', organismoIds)
          data = result.data
          error = result.error
        } else {
          const result = await supabase
            .from('organismos')
            .select(`
              id, rut, nombre,
              unidades (
                id, nombre,
                contactos (
                  resp_pago, email_pago,
                  resp_contrato, email_contrato,
                  fono_contrato, ejecutivo_compras,
                  licitacion_origen, codigo_licitacion,
                  folio_factura, found_at
                )
              )
            `)
            .or(`rut.eq.${q},nombre.ilike.%${q}%`)
            .limit(10)
          data = result.data
          error = result.error
        }
      } else {
        const result = await supabase
          .from('organismos')
          .select(`
            id, rut, nombre,
            unidades (
              id, nombre,
              contactos (
                resp_pago, email_pago,
                resp_contrato, email_contrato,
                fono_contrato, ejecutivo_compras,
                licitacion_origen, codigo_licitacion,
                folio_factura, found_at
              )
            )
          `)
          .or(`rut.eq.${q},nombre.ilike.%${q}%`)
          .limit(10)
        data = result.data
        error = result.error
      }

      if (error) throw error
      return res.status(200).json({ data: data || [] })
    } catch (e) {
      return res.status(500).json({ error: e.message })
    }
  }

  return res.status(405).json({ error: 'Método no permitido' })
}
