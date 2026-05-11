import { supabase } from '../../lib/supabase'

export default async function handler(req, res) {
  if (req.method === 'POST') {
    const { rut_organismo, nombre_organismo, nombre_unidad, contacto } = req.body

    try {
      // Upsert organismo
      let { data: organismo, error: errOrg } = await supabase
        .from('organismos')
        .upsert({ rut: rut_organismo, nombre: nombre_organismo }, { onConflict: 'rut' })
        .select()
        .single()

      if (errOrg) throw errOrg

      // Upsert unidad
      let { data: unidad, error: errUni } = await supabase
        .from('unidades')
        .upsert({ organismo_id: organismo.id, nombre: nombre_unidad }, { onConflict: 'organismo_id,nombre' })
        .select()
        .single()

      if (errUni) throw errUni

      // Insert contacto (siempre nuevo, nunca sobreescribe)
      const { error: errCon } = await supabase
        .from('contactos')
        .insert({
          unidad_id: unidad.id,
          resp_pago: contacto.resp_pago,
          email_pago: contacto.email_pago,
          resp_contrato: contacto.resp_contrato,
          email_contrato: contacto.email_contrato,
          fono_contrato: contacto.fono_contrato,
          ejecutivo_compras: contacto.ejecutivo_compras,
          licitacion_origen: contacto.licitacion_origen,
          codigo_licitacion: contacto.codigo_licitacion,
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
      const { data, error } = await supabase
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
              found_at
            )
          )
        `)
        .or(`rut.eq.${q},nombre.ilike.%${q}%`)
        .limit(10)

      if (error) throw error

      return res.status(200).json({ data })
    } catch (e) {
      return res.status(500).json({ error: e.message })
    }
  }

  return res.status(405).json({ error: 'Método no permitido' })
}
