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
      // Volver a buscar en base para mostrar lo que se guardó
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
    const rows = [['Organismo', 'RUT', 'Unidad', 'Resp. Pago', 'Email Pago', 'Resp. Contrato', 'Email Contrato', 'Fono', 'Ejecutivo Compras', 'Licitación', 'Código', 'Fecha']]
    resultados.forEach(org => {
      org.unidades.forEach(uni => {
        uni.contactos.forEach(c => {
          rows.push([
            org.nombre, org.rut, uni.nombre,
            c.resp_pago || '', c.email_pago || '',
            c.resp_contrato || '', c.email_contrato || '',
            c.fono_contrato || '', c.ejecutivo_compras || '',
            c.licitacion_origen || '', c.codigo_licitacion || '',
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

      <div style={{ minHeight: '100vh', background: '#f8f7f4', fontFamily: 'system-ui, sans-serif' }}>

        {/* Navbar */}
        <nav style={{ background: '#1a1a2e', padding: '0 32px', display: 'flex', alignItems: 'center', gap: 32, height: 56 }}>
          <span style={{ color: '#fff', fontWeight: 700, fontSize: 16, letterSpacing: 1 }}>VanTrust Capital</span>
          <Link href="/" style={{ color: '#aaa', textDecoration: 'none', fontSize: 14 }}>Extractor</Link>
          <Link href="/contactos" style={{ color: '#fff', textDecoration: 'none', fontSize: 14, borderBottom: '2px solid #4f8ef7', paddingBottom: 4 }}>Contactos MP</Link>
        </nav>

        <div style={{ maxWidth: 900, margin: '0 auto', padding: '40px 24px' }}>

          <h1 style={{ fontSize: 26, fontWeight: 700, color: '#1a1a2e', marginBottom: 4 }}>Contactos Mercado Público</h1>
          <p style={{ color: '#666', marginBottom: 32, fontSize: 14 }}>Base de responsables de pago y contrato extraídos automáticamente desde facturas procesadas.</p>

          {/* Buscador */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && buscarEnBase()}
              placeholder="RUT, nombre de organismo o código OC..."
              style={{ flex: 1, padding: '10px 16px', borderRadius: 8, border: '1px solid #ddd', fontSize: 15, outline: 'none' }}
            />
            <button
              onClick={buscarEnBase}
              disabled={cargando}
              style={{ background: '#1a1a2e', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 20px', cursor: 'pointer', fontSize: 14, fontWeight: 600 }}
            >
              {cargando ? 'Buscando...' : 'Buscar en base'}
            </button>
            <button
              onClick={buscarEnMP}
              disabled={cargando}
              style={{ background: '#4f8ef7', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 20px', cursor: 'pointer', fontSize: 14, fontWeight: 600 }}
            >
              Buscar en MP
            </button>
          </div>

          {error && (
            <div style={{ background: '#fff0f0', border: '1px solid #fcc', borderRadius: 8, padding: '12px 16px', color: '#c00', marginBottom: 16, fontSize: 14 }}>
              {error}
            </div>
          )}

          {buscadoEnMP && (
            <div style={{ background: '#f0fff4', border: '1px solid #9be', borderRadius: 8, padding: '12px 16px', color: '#1a7a4a', marginBottom: 16, fontSize: 14 }}>
              Búsqueda en MP completada — los contactos encontrados quedaron guardados en la base.
            </div>
          )}

          {/* Resultados */}
          {resultados.length > 0 && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <span style={{ fontSize: 14, color: '#666' }}>{resultados.length} organismo(s) encontrado(s)</span>
                <button
                  onClick={exportarExcel}
                  style={{ background: '#217346', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
                >
                  Exportar Excel
                </button>
              </div>

              {resultados.map(org => (
                <div key={org.id} style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e5e5', marginBottom: 20, overflow: 'hidden' }}>
                  <div style={{ background: '#1a1a2e', padding: '14px 20px' }}>
                    <div style={{ color: '#fff', fontWeight: 700, fontSize: 16 }}>{org.nombre}</div>
                    <div style={{ color: '#aaa', fontSize: 13, marginTop: 2 }}>RUT {org.rut}</div>
                  </div>

                  {org.unidades.map(uni => (
                    <div key={uni.id} style={{ borderTop: '1px solid #f0f0f0' }}>
                      <div style={{ padding: '10px 20px', background: '#f8f7f4', fontSize: 13, fontWeight: 600, color: '#444' }}>
                        {uni.nombre}
                      </div>

                      {uni.contactos.map((c, i) => (
                        <div key={i} style={{ padding: '14px 20px', borderTop: '1px solid #f5f5f5', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 24px' }}>
                          {c.resp_pago && (
                            <div>
                              <div style={{ fontSize: 11, color: '#999', textTransform: 'uppercase', letterSpacing: 0.5 }}>Resp. Pago</div>
                              <div style={{ fontSize: 14, color: '#222' }}>{c.resp_pago}</div>
                              {c.email_pago && <div style={{ fontSize: 13, color: '#4f8ef7' }}>{c.email_pago}</div>}
                            </div>
                          )}
                          {c.resp_contrato && (
                            <div>
                              <div style={{ fontSize: 11, color: '#999', textTransform: 'uppercase', letterSpacing: 0.5 }}>Resp. Contrato</div>
                              <div style={{ fontSize: 14, color: '#222' }}>{c.resp_contrato}</div>
                              {c.email_contrato && <div style={{ fontSize: 13, color: '#4f8ef7' }}>{c.email_contrato}</div>}
                              {c.fono_contrato && <div style={{ fontSize: 13, color: '#666' }}>{c.fono_contrato}</div>}
                            </div>
                          )}
                          {c.ejecutivo_compras && (
                            <div>
                              <div style={{ fontSize: 11, color: '#999', textTransform: 'uppercase', letterSpacing: 0.5 }}>Ejecutivo Compras</div>
                              <div style={{ fontSize: 14, color: '#222' }}>{c.ejecutivo_compras}</div>
                            </div>
                          )}
                          {c.codigo_licitacion && (
                            <div>
                              <div style={{ fontSize: 11, color: '#999', textTransform: 'uppercase', letterSpacing: 0.5 }}>Licitación origen</div>
                              <div style={{ fontSize: 13, color: '#666' }}>{c.codigo_licitacion}</div>
                              <div style={{ fontSize: 12, color: '#bbb' }}>{c.found_at ? new Date(c.found_at).toLocaleDateString('es-CL') : ''}</div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          {resultados.length === 0 && !cargando && query && !error && (
            <div style={{ textAlign: 'center', padding: '48px 0', color: '#999', fontSize: 15 }}>
              No hay resultados en la base para <strong>{query}</strong>.<br />
              <span style={{ fontSize: 13 }}>Usa "Buscar en MP" para consultar en tiempo real y guardar automáticamente.</span>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
