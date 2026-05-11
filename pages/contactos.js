import { useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'

export default function Contactos() {
  const [query, setQuery] = useState('')
  const [resultados, setResultados] = useState([])
  const [cargando, setCargando] = useState(false)
  const [error, setError] = useState(null)
  const [buscadoEnMP, setBuscadoEnMP] = useState(false)

  async function buscarEnBase() {
    if (!query.trim()) return
    setCargando(true)
    setError(null)
    setBuscadoEnMP(false)
    try {
      const r = await fetch('/api/contactos?q=' + encodeURIComponent(query.trim()))
      const json = await r.json()
      if (json.error) throw new Error(json.error)
      setResultados(json.data || [])
    } catch (e) {
      setError(e.message)
    } finally {
      setCargando(false)
    }
  }

  async function buscarEnMP() {
    if (!query.trim()) return
    setCargando(true)
    setError(null)
    try {
      const r = await fetch('/api/mercadopublico', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ razon_social_deudor: query.trim() })
      })
      const json = await r.json()
      if (json.error) throw new Error(json.error)
      setBuscadoEnMP(true)
      const r2 = await fetch('/api/contactos?q=' + encodeURIComponent(query.trim()))
      const json2 = await r2.json()
      setResultados(json2.data || [])
    } catch (e) {
      setError(e.message)
    } finally {
      setCargando(false)
    }
  }

  function exportarExcel() {
    const rows = [['Organismo', 'RUT Organismo', 'Unidad', 'Resp. Pago', 'Email Pago', 'Resp. Contrato', 'Email Contrato', 'Fono', 'Ejecutivo Compras', 'Licitación', 'Código', 'Folio Factura', 'RUT Deudor', 'Fecha']]
    resultados.forEach(org => {
      org.unidades.forEach(uni => {
        uni.contactos.forEach(c => {
          rows.push([
            org.nombre, org.rut, uni.nombre,
            c.resp_pago || '', c.email_pago || '',
            c.resp_contrato || '', c.email_contrato || '',
            c.fono_contrato || '', c.ejecutivo_compras || '',
            c.licitacion_origen || '', c.codigo_licitacion || '',
            c.folio_factura || '', c.rut_deudor || '',
            c.found_at ? new Date(c.found_at).toLocaleDateString('es-CL') : ''
          ])
        })
      })
    })
    const csv = rows.map(r => r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\n')
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'contactos_mp.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <>
      <Head>
        <title>Contactos MP — VanTrust</title>
      </Head>

      <div style={{ minHeight: '100vh', background: '#F2F4F7', fontFamily: "'DM Sans', system-ui, sans-serif" }}>

        <nav style={{ background: '#1A2B3C', padding: '0 24px', display: 'flex', alignItems: 'center', gap: 10, height: 56, borderBottom: '2px solid #2AADB8' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,5px)', gap: 3 }}>
            {[1,2,3,4,5,6,7,8,9].map((_, i) => (
              <div key={i} style={{ width: 5, height: 5, borderRadius: '50%', background: '#2AADB8', opacity: [0,3,6,8].includes(i) ? 0.25 : 1 }}/>
            ))}
          </div>
          <span style={{ color: '#fff', fontWeight: 700, fontSize: 15, marginLeft: 8 }}>
            Van<span style={{ color: '#2AADB8' }}>Trust</span> Capital
          </span>
          <span style={{ color: 'rgba(255,255,255,.2)', margin: '0 10px' }}>|</span>
          <Link href="/" style={{ color: 'rgba(255,255,255,.45)', textDecoration: 'none', fontSize: 13, fontWeight: 500 }}>Extractor</Link>
          <Link href="/contactos" style={{ color: '#fff', textDecoration: 'none', fontSize: 13, fontWeight: 600, borderBottom: '2px solid #2AADB8', paddingBottom: 4 }}>Contactos MP</Link>
        </nav>

        <div style={{ maxWidth: 960, margin: '0 auto', padding: '40px 24px' }}>

          <h1 style={{ fontSize: 24, fontWeight: 700, color: '#1A2B3C', marginBottom: 4 }}>Contactos Mercado Público</h1>
          <p style={{ color: '#6B7A8D', marginBottom: 32, fontSize: 14 }}>
            Base de responsables extraídos automáticamente. Busca por RUT, nombre de organismo o número de factura.
          </p>

          <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && buscarEnBase()}
              placeholder="RUT, nombre de organismo o N° factura..."
              style={{ flex: 1, padding: '10px 16px', borderRadius: 8, border: '1px solid #DDE2EA', fontSize: 14, outline: 'none', fontFamily: 'inherit', background: '#fff', color: '#1A2B3C' }}
            />
            <button onClick={buscarEnBase} disabled={cargando}
              style={{ background: '#1A2B3C', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 20px', cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit' }}>
              {cargando ? 'Buscando...' : 'Buscar en base'}
            </button>
            <button onClick={buscarEnMP} disabled={cargando}
              style={{ background: '#2AADB8', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 20px', cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit' }}>
              Buscar en MP
            </button>
          </div>

          {error && (
            <div style={{ background: '#FFF0F0', border: '1px solid #FCC', borderRadius: 8, padding: '12px 16px', color: '#C00000', marginBottom: 16, fontSize: 13 }}>
              {error}
            </div>
          )}

          {buscadoEnMP && (
            <div style={{ background: '#E1F5EE', border: '1px solid #9BE', borderRadius: 8, padding: '12px 16px', color: '#0A7055', marginBottom: 16, fontSize: 13 }}>
              Búsqueda en MP completada — los contactos encontrados quedaron guardados en la base.
            </div>
          )}

          {resultados.length > 0 && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <span style={{ fontSize: 13, color: '#6B7A8D' }}>{resultados.length} organismo(s) encontrado(s)</span>
                <button onClick={exportarExcel}
                  style={{ background: '#217346', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit' }}>
                  ⬇ Exportar Excel
                </button>
              </div>

              {resultados.map(org => (
                <div key={org.id} style={{ background: '#fff', borderRadius: 12, border: '1px solid #DDE2EA', marginBottom: 20, overflow: 'hidden' }}>
                  <div style={{ background: '#1A2B3C', padding: '14px 20px' }}>
                    <div style={{ color: '#fff', fontWeight: 700, fontSize: 15 }}>{org.nombre}</div>
                    <div style={{ color: 'rgba(255,255,255,.5)', fontSize: 12, marginTop: 2 }}>RUT {org.rut}</div>
                  </div>

                  {org.unidades.map(uni => (
                    <div key={uni.id} style={{ borderTop: '1px solid #F0F0F0' }}>
                      <div style={{ padding: '10px 20px', background: '#F8FAFB', fontSize: 12, fontWeight: 600, color: '#6B7A8D', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        {uni.nombre}
                      </div>

                      {uni.contactos.map((c, i) => (
                        <div key={i} style={{ padding: '14px 20px', borderTop: '1px solid #F5F5F5', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px 24px' }}>
                          {c.resp_pago && (
                            <div>
                              <div style={{ fontSize: 10, color: '#6B7A8D', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>Resp. Pago</div>
                              <div style={{ fontSize: 13, color: '#1A2B3C', fontWeight: 500 }}>{c.resp_pago}</div>
                              {c.email_pago && <div style={{ fontSize: 12, color: '#1A6AB5', marginTop: 2 }}>{c.email_pago}</div>}
                            </div>
                          )}
                          {c.resp_contrato && (
                            <div>
                              <div style={{ fontSize: 10, color: '#6B7A8D', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>Resp. Contrato</div>
                              <div style={{ fontSize: 13, color: '#1A2B3C', fontWeight: 500 }}>{c.resp_contrato}</div>
                              {c.email_contrato && <div style={{ fontSize: 12, color: '#1A6AB5', marginTop: 2 }}>{c.email_contrato}</div>}
                              {c.fono_contrato && <div style={{ fontSize: 12, color: '#6B7A8D', marginTop: 2 }}>📞 {c.fono_contrato}</div>}
                            </div>
                          )}
                          <div>
                            {c.ejecutivo_compras && (
                              <>
                                <div style={{ fontSize: 10, color: '#6B7A8D', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>Ejecutivo Compras</div>
                                <div style={{ fontSize: 13, color: '#1A2B3C', fontWeight: 500, marginBottom: 8 }}>{c.ejecutivo_compras}</div>
                              </>
                            )}
                            {(c.codigo_licitacion || c.folio_factura || c.rut_deudor) && (
                              <>
                                <div style={{ fontSize: 10, color: '#6B7A8D', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>Origen</div>
                                {c.folio_factura && <div style={{ fontSize: 12, color: '#1A2B3C', fontWeight: 500 }}>Factura N° {c.folio_factura}</div>}
                                {c.rut_deudor && <div style={{ fontSize: 11, color: '#6B7A8D', marginTop: 1 }}>RUT deudor: {c.rut_deudor}</div>}
                                {c.codigo_licitacion && <div style={{ fontSize: 11, color: '#7C3AED', fontFamily: 'monospace', marginTop: 1 }}>{c.codigo_licitacion}</div>}
                                <div style={{ fontSize: 11, color: '#6B7A8D', marginTop: 2 }}>{c.found_at ? new Date(c.found_at).toLocaleDateString('es-CL') : ''}</div>
                              </>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          {resultados.length === 0 && !cargando && query && !error && (
            <div style={{ textAlign: 'center', padding: '48px 0', color: '#6B7A8D', fontSize: 14 }}>
              No hay resultados en la base para <strong style={{ color: '#1A2B3C' }}>{query}</strong>.<br />
              <span style={{ fontSize: 13 }}>Usa "Buscar en MP" para consultar en tiempo real y guardar automáticamente.</span>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
