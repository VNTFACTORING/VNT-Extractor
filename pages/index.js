import { useState, useRef } from 'react';
import Head from 'next/head';
 
export default function Home() {
  const [files, setFiles] = useState([]);
  const [results, setResults] = useState([]);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [statuses, setStatuses] = useState({});
  const [over, setOver] = useState(false);
  const [mpData, setMpData] = useState({});   // { rowIndex: { loading, data, error } }
  const inputRef = useRef();
 
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
 
  function normalizeRut(rut) {
    if (!rut) return rut;
    let r = String(rut).trim().replace(/\./g, '').toUpperCase();
    if (!r.includes('-') && r.length > 1) r = r.slice(0, -1) + '-' + r.slice(-1);
    return r;
  }
 
  function addFiles(newFiles) {
    setFiles(prev => {
      const existing = new Set(prev.map(f => f.name + f.size));
      const filtered = [...newFiles].filter(f => !existing.has(f.name + f.size));
      return [...prev, ...filtered];
    });
    setResults([]); setStatuses({}); setMpData({});
  }
 
  function removeFile(i) { setFiles(prev => prev.filter((_, idx) => idx !== i)); }
 
  function clearAll() {
    setFiles([]); setResults([]); setStatuses({});
    setProgress({ current: 0, total: 0 }); setMpData({});
  }
 
  async function toB64(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result.split(',')[1]);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
  }
 
  async function extract() {
    if (!files.length || processing) return;
    setProcessing(true); setResults([]); setMpData({});
    const ns = {}; files.forEach((_, i) => { ns[i] = 'queue'; }); setStatuses({ ...ns });
 
    const allResults = [];
    for (let i = 0; i < files.length; i++) {
      setProgress({ current: i + 1, total: files.length });
      setStatuses(prev => ({ ...prev, [i]: 'processing' }));
      try {
        const b64 = await toB64(files[i]);
        const res = await fetch('/api/extract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileData: b64, mimeType: files[i].type || 'application/pdf' })
        });
        if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'Error ' + res.status); }
        const data = await res.json();
        if (data.rut_emisor) data.rut_emisor = normalizeRut(data.rut_emisor);
        if (data.rut_deudor) data.rut_deudor = normalizeRut(data.rut_deudor);
        allResults.push({ ok: true, data, filename: files[i].name });
        setStatuses(prev => ({ ...prev, [i]: 'done' }));
      } catch (e) {
        allResults.push({ ok: false, error: e.message, filename: files[i].name });
        setStatuses(prev => ({ ...prev, [i]: 'error' }));
      }
      if (i < files.length - 1) await sleep(2500);
    }
    setResults(allResults);
    setProcessing(false);
  }
 
  async function consultarMP(rowIndex, rut_deudor, razon_social_deudor, ref_oc) {
    setMpData(prev => ({ ...prev, [rowIndex]: { loading: true } }));
    try {
      const res = await fetch('/api/mercadopublico', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rut_deudor, razon_social_deudor, ref_oc })
      });
      const data = await res.json();
      setMpData(prev => ({ ...prev, [rowIndex]: { loading: false, data } }));
    } catch (e) {
      setMpData(prev => ({ ...prev, [rowIndex]: { loading: false, error: e.message } }));
    }
  }
 
  function fmt(v, money) {
    if (v === null || v === undefined) return '—';
    if (money) return '$\u00A0' + Number(v).toLocaleString('es-CL');
    return String(v);
  }
 
  function toDateGVE(fecha) {
    if (!fecha) return '';
    if (fecha.includes('/')) { const [dd, mm, yyyy] = fecha.split('/'); return `${yyyy}-${mm}-${dd}`; }
    return fecha;
  }
 
  function exportGVE() {
    const ok = results.filter(r => r.ok);
    if (!ok.length) return;
    const hdr = ['RUTconGuión','RazonSocial','MontoDocto','FechaVenc','NumDocto','N° OC','N° Presupuesto','N° Estado de Pago / Folio Ref'];
    const rows = ok.map(r => {
      const d = r.data;
      return [d.rut_deudor||'', d.razon_social_deudor||'', d.total||'', toDateGVE(d.fecha_vencimiento||d.fecha_emision), d.numero_folio||'', d.ref_oc||'', d.ref_presupuesto||'', d.ref_edp||''];
    });
    navigator.clipboard.writeText([hdr,...rows].map(r=>r.join('\t')).join('\n'))
      .then(()=>alert('✓ Copiado en formato GVE'))
      .catch(()=>alert('No se pudo copiar automáticamente.'));
  }
 
  function exportCompleto() {
    const ok = results.filter(r => r.ok);
    if (!ok.length) return;
    const hdr = ['Archivo','Tipo','Folio','RUT Emisor','Emisor','RUT Deudor','Deudor','F. Emisión','F. Venc.','Neto','IVA','Total','N° OC','N° Presupuesto','N° EDP','Org MP','Cód MP','Responsable MP','Email MP','Teléfono MP'];
    const rows = ok.map((r, i) => {
      const d = r.data;
      const mp = mpData[i]?.data;
      return [
        r.filename, d.tipo_documento||'', d.numero_folio||'',
        d.rut_emisor||'', d.razon_social_emisor||'',
        d.rut_deudor||'', d.razon_social_deudor||'',
        d.fecha_emision||'', d.fecha_vencimiento||'',
        d.monto_neto||'', d.iva||'', d.total||'',
        d.ref_oc||'', d.ref_presupuesto||'', d.ref_edp||'',
        mp?.org?.nombre||'', mp?.org?.codigo||'',
        mp?.oc?.responsable_nombre||'', mp?.oc?.responsable_email||'', mp?.oc?.responsable_fono||'',
      ];
    });
    navigator.clipboard.writeText([hdr,...rows].map(r=>r.join('\t')).join('\n'))
      .then(()=>alert('✓ Copiado completo'))
      .catch(()=>alert('No se pudo copiar automáticamente.'));
  }
 
  const okResults = results.filter(r => r.ok);
  const totalNeto = okResults.reduce((s, r) => s + (r.data.monto_neto || 0), 0);
  const totalFinal = okResults.reduce((s, r) => s + (r.data.total || 0), 0);
  const statusLabel = { queue:'En cola', processing:'Procesando…', done:'✓ Listo', error:'Error' };
  const statusColor = { queue:'#6B7A8D', processing:'#1A6AB5', done:'#0A7055', error:'#C00000' };
  const statusBg   = { queue:'#F2F4F7', processing:'#E8F4FF', done:'#E1F5EE', error:'#FFF0F0' };
 
  return (
    <>
      <Head>
        <title>Extractor de Facturas · VanTrust Capital</title>
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />
      </Head>
      <style>{`
        * { box-sizing:border-box; margin:0; padding:0; }
        body { font-family:'DM Sans',sans-serif; background:#F2F4F7; color:#1A2B3C; min-height:100vh; }
        .top { background:#1A2B3C; height:56px; display:flex; align-items:center; padding:0 1.5rem; gap:10px; border-bottom:2px solid #2AADB8; }
        .dots { display:grid; grid-template-columns:repeat(3,5px); gap:3px; }
        .dot { width:5px; height:5px; border-radius:50%; background:#2AADB8; }
        .dot.dim { opacity:.25; }
        .brand { font-size:15px; font-weight:700; color:#fff; margin-left:8px; }
        .brand span { color:#2AADB8; }
        .sep { color:rgba(255,255,255,.2); margin:0 10px; }
        .tool { font-size:13px; color:rgba(255,255,255,.45); }
        .page { max-width:1200px; margin:0 auto; padding:2rem 1.5rem 4rem; }
        .drop { background:#fff; border-radius:14px; border:2px dashed #DDE2EA; padding:2.5rem 2rem; text-align:center; cursor:pointer; transition:all .15s; margin-bottom:1rem; }
        .drop.over,.drop:hover { border-color:#2AADB8; background:#E6F7F9; }
        .drop.has { border-style:solid; border-color:#2AADB8; background:#E6F7F9; }
        .drop-icon { width:56px; height:56px; border-radius:14px; background:#E6F7F9; margin:0 auto .875rem; display:flex; align-items:center; justify-content:center; font-size:28px; transition:background .2s; }
        .drop.has .drop-icon { background:#2AADB8; }
        .drop-title { font-size:17px; font-weight:600; color:#1A2B3C; margin-bottom:5px; }
        .drop-sub { font-size:13px; color:#6B7A8D; }
        .fmts { display:flex; justify-content:center; gap:6px; margin-top:12px; flex-wrap:wrap; }
        .fmt { font-size:11px; font-weight:500; padding:3px 10px; border-radius:20px; background:#F2F4F7; color:#6B7A8D; border:1px solid #DDE2EA; }
        .queue-list { display:flex; flex-direction:column; gap:6px; margin-bottom:1rem; }
        .qi { background:#fff; border:1px solid #DDE2EA; border-radius:10px; padding:10px 14px; display:flex; align-items:center; gap:12px; }
        .qi-ico { width:34px; height:34px; background:#F2F4F7; border-radius:7px; display:flex; align-items:center; justify-content:center; font-size:16px; flex-shrink:0; }
        .qi-info { flex:1; min-width:0; }
        .qi-name { font-size:13px; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:#1A2B3C; }
        .qi-size { font-size:11px; color:#6B7A8D; margin-top:1px; }
        .qi-st { flex-shrink:0; font-size:11px; font-weight:600; padding:3px 9px; border-radius:20px; }
        .qi-rm { background:none; border:none; cursor:pointer; color:#6B7A8D; font-size:18px; padding:2px 6px; }
        .qi-rm:hover { color:#C00000; }
        .actions { display:flex; gap:8px; margin-bottom:1.5rem; }
        .btn-main { flex:1; padding:13px; background:#2AADB8; color:#fff; font-size:15px; font-weight:600; font-family:'DM Sans',sans-serif; border:none; border-radius:10px; cursor:pointer; transition:background .15s; }
        .btn-main:hover:not(:disabled) { background:#1F8A94; }
        .btn-main:disabled { opacity:.45; cursor:not-allowed; }
        .btn-sec { padding:12px 18px; background:#fff; color:#6B7A8D; font-size:13px; font-weight:500; font-family:'DM Sans',sans-serif; border:1px solid #DDE2EA; border-radius:10px; cursor:pointer; }
        .btn-sec:hover { background:#F2F4F7; }
        .prog { margin-bottom:1.25rem; }
        .prog-label { font-size:12px; color:#6B7A8D; margin-bottom:6px; }
        .prog-bar { height:6px; background:#DDE2EA; border-radius:6px; overflow:hidden; }
        .prog-fill { height:100%; background:#2AADB8; border-radius:6px; transition:width .4s ease; }
        .summary { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:1rem; }
        .sc { background:#fff; border:1px solid #DDE2EA; border-radius:10px; padding:14px 16px; }
        .sl { font-size:10px; font-weight:700; color:#6B7A8D; text-transform:uppercase; letter-spacing:.07em; margin-bottom:5px; }
        .sv { font-size:22px; font-weight:700; color:#1A2B3C; font-family:'DM Mono',monospace; }
        .sv.accent { color:#1F8A94; }
        .results-hdr { display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; flex-wrap:wrap; gap:8px; }
        .results-title { font-size:14px; font-weight:600; color:#1A2B3C; }
        .export-btns { display:flex; gap:8px; flex-wrap:wrap; }
        .btn-exp-gve { display:inline-flex; align-items:center; gap:6px; padding:9px 18px; background:#1A2B3C; color:#fff; font-size:13px; font-weight:600; font-family:'DM Sans',sans-serif; border:none; border-radius:8px; cursor:pointer; }
        .btn-exp-gve:hover { opacity:.85; }
        .btn-exp-full { display:inline-flex; align-items:center; gap:6px; padding:9px 18px; background:#fff; color:#1A2B3C; font-size:13px; font-weight:600; font-family:'DM Sans',sans-serif; border:1px solid #DDE2EA; border-radius:8px; cursor:pointer; }
        .btn-exp-full:hover { background:#F2F4F7; }
        .tbl-wrap { background:#fff; border:1px solid #DDE2EA; border-radius:14px; overflow:auto; }
        table { width:100%; border-collapse:collapse; min-width:1300px; }
        thead th { padding:10px 14px; text-align:left; font-size:10px; font-weight:700; color:#6B7A8D; text-transform:uppercase; letter-spacing:.07em; background:#F2F4F7; border-bottom:1px solid #DDE2EA; white-space:nowrap; }
        thead th.gve { background:#E6F7F9; color:#1F8A94; }
        thead th.ref { background:#FFF8E6; color:#A67700; }
        thead th.mp  { background:#F0EEFF; color:#5B2ED8; }
        tbody tr { border-bottom:.5px solid #DDE2EA; }
        tbody tr:last-child { border-bottom:none; }
        tbody tr:hover { background:#F8FAFB; }
        tbody td { padding:10px 14px; font-family:'DM Mono',monospace; font-size:12px; vertical-align:top; }
        tbody td.nm { font-family:'DM Sans',sans-serif; font-weight:500; color:#1A2B3C; font-size:13px; }
        .money { font-weight:600; color:#1F8A94; }
        .total-m { font-weight:700; color:#1A2B3C; }
        .err-row { color:#C00000; font-family:'DM Sans',sans-serif; font-size:12px; }
        .conf-baja { color:#C00000; font-weight:700; }
        .ref-val { font-weight:600; color:#A67700; }
        .empty-ref { color:#DDE2EA; }
        .btn-mp { display:inline-flex; align-items:center; gap:5px; padding:5px 11px; background:#F0EEFF; color:#5B2ED8; font-size:11px; font-weight:700; font-family:'DM Sans',sans-serif; border:1px solid #C4B5FD; border-radius:6px; cursor:pointer; white-space:nowrap; }
        .btn-mp:hover { background:#E5DCFF; }
        .btn-mp:disabled { opacity:.5; cursor:not-allowed; }
        .mp-cell { min-width:200px; }
        .mp-org { font-family:'DM Sans',sans-serif; font-size:12px; font-weight:600; color:#5B2ED8; }
        .mp-sub { font-family:'DM Sans',sans-serif; font-size:11px; color:#6B7A8D; margin-top:2px; }
        .mp-resp { font-family:'DM Sans',sans-serif; font-size:12px; font-weight:600; color:#1A2B3C; margin-top:6px; }
        .mp-email { font-family:'DM Mono',monospace; font-size:11px; color:#1A6AB5; margin-top:2px; }
        .mp-err { font-family:'DM Sans',sans-serif; font-size:11px; color:#C00000; }
        .footer { text-align:center; padding:2rem 0 1rem; font-size:11px; color:#6B7A8D; }
        .footer a { color:#2AADB8; text-decoration:none; }
        @media(max-width:500px){ .summary{grid-template-columns:1fr;} }
      `}</style>
 
      <div className="top">
        <div className="dots">
          <div className="dot dim"/><div className="dot"/><div className="dot dim"/>
          <div className="dot"/><div className="dot"/><div className="dot"/>
          <div className="dot dim"/><div className="dot"/><div className="dot dim"/>
        </div>
        <span className="brand">Van<span>Trust</span> Capital</span>
        <span className="sep">|</span>
        <span className="tool">Extractor de Facturas</span>
      </div>
 
      <div className="page">
        <input ref={inputRef} type="file" accept=".pdf,image/png,image/jpeg,image/webp" multiple style={{display:'none'}}
          onChange={e => { addFiles(e.target.files); e.target.value=''; }} />
 
        <div className={`drop${files.length?' has':''}${over?' over':''}`}
          onClick={() => inputRef.current.click()}
          onDragOver={e => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={e => { e.preventDefault(); setOver(false); addFiles(e.dataTransfer.files); }}>
          <div className="drop-icon">{files.length ? '📂' : '📄'}</div>
          <div className="drop-title">{files.length ? `${files.length} factura${files.length>1?'s':''} lista${files.length>1?'s':''}` : 'Arrastra las facturas aquí'}</div>
          <div className="drop-sub">{files.length ? 'Clic para agregar más archivos' : 'Puedes subir varias a la vez · PDF o imagen'}</div>
          <div className="fmts"><span className="fmt">PDF</span><span className="fmt">PNG / JPG</span><span className="fmt">Múltiples archivos</span></div>
        </div>
 
        {files.length > 0 && (
          <div className="queue-list">
            {files.map((f, i) => (
              <div className="qi" key={i}>
                <div className="qi-ico">📄</div>
                <div className="qi-info">
                  <div className="qi-name">{f.name}</div>
                  <div className="qi-size">{(f.size/1024).toFixed(0)} KB</div>
                </div>
                <span className="qi-st" style={{background:statusBg[statuses[i]||'queue'], color:statusColor[statuses[i]||'queue']}}>
                  {statusLabel[statuses[i]||'queue']}
                </span>
                {!processing && <button className="qi-rm" onClick={() => removeFile(i)}>×</button>}
              </div>
            ))}
          </div>
        )}
 
        {files.length > 0 && (
          <div className="actions">
            <button className="btn-main" onClick={extract} disabled={processing}>
              {processing ? `Procesando ${progress.current} de ${progress.total}…` : '⬇ Extraer datos'}
            </button>
            {!processing && <button className="btn-sec" onClick={clearAll}>Limpiar</button>}
          </div>
        )}
 
        {processing && (
          <div className="prog">
            <div className="prog-label">Procesando {progress.current} de {progress.total}…</div>
            <div className="prog-bar"><div className="prog-fill" style={{width:`${(progress.current/progress.total)*100}%`}}/></div>
          </div>
        )}
 
        {results.length > 0 && (
          <>
            {okResults.length > 0 && (
              <div className="summary">
                <div className="sc"><div className="sl">Facturas procesadas</div><div className="sv">{okResults.length}</div></div>
                <div className="sc"><div className="sl">Total neto acumulado</div><div className="sv accent">${totalNeto.toLocaleString('es-CL')}</div></div>
                <div className="sc"><div className="sl">Total con IVA</div><div className="sv">${totalFinal.toLocaleString('es-CL')}</div></div>
              </div>
            )}
            <div className="results-hdr">
              <span className="results-title">{okResults.length} factura{okResults.length!==1?'s':''} extraída{okResults.length!==1?'s':''}</span>
              {okResults.length > 0 && (
                <div className="export-btns">
                  <button className="btn-exp-gve" onClick={exportGVE}>⬇ Exportar GVE (Carga Masiva)</button>
                  <button className="btn-exp-full" onClick={exportCompleto}>⬇ Exportar completo</button>
                </div>
              )}
            </div>
            <div className="tbl-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Archivo</th><th>Tipo</th><th>Folio</th>
                    <th className="gve">RUT Emisor</th><th>Emisor</th>
                    <th className="gve">RUT Deudor</th><th>Deudor</th>
                    <th>F. Emisión</th><th className="gve">F. Venc.</th>
                    <th className="gve">Neto</th><th>IVA</th><th className="gve">Total</th>
                    <th className="ref">N° OC</th><th className="ref">N° Presupuesto</th><th className="ref">N° EDP</th>
                    <th className="mp">Responsable MP</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r, i) => {
                    const mp = mpData[i];
                    return r.ok ? (
                      <tr key={i}>
                        <td className="nm">{r.filename.length>22?r.filename.slice(0,20)+'…':r.filename}</td>
                        <td>{fmt(r.data.tipo_documento)}</td>
                        <td style={{fontWeight:600}}>{fmt(r.data.numero_folio)}</td>
                        <td className={r.data.confianza?.rut_emisor==='baja'?'conf-baja':''}>{fmt(r.data.rut_emisor)}</td>
                        <td>{fmt(r.data.razon_social_emisor)}</td>
                        <td className={r.data.confianza?.rut_deudor==='baja'?'conf-baja':''}>{fmt(r.data.rut_deudor)}</td>
                        <td>{fmt(r.data.razon_social_deudor)}</td>
                        <td>{fmt(r.data.fecha_emision)}</td>
                        <td style={{fontWeight:600}}>{fmt(r.data.fecha_vencimiento)}</td>
                        <td className="money">{fmt(r.data.monto_neto, true)}</td>
                        <td>{fmt(r.data.iva, true)}</td>
                        <td className="total-m">{fmt(r.data.total, true)}</td>
                        <td className={r.data.ref_oc?'ref-val':'empty-ref'}>{r.data.ref_oc||'—'}</td>
                        <td className={r.data.ref_presupuesto?'ref-val':'empty-ref'}>{r.data.ref_presupuesto||'—'}</td>
                        <td className={r.data.ref_edp?'ref-val':'empty-ref'}>{r.data.ref_edp||'—'}</td>
                        <td className="mp-cell">
                          {!mp && (
                            <button className="btn-mp"
                              onClick={() => consultarMP(i, r.data.rut_deudor, r.data.razon_social_deudor, r.data.ref_oc)}>
                              🔍 Consultar MP
                            </button>
                          )}
                          {mp?.loading && <span style={{fontSize:11,color:'#5B2ED8'}}>Consultando…</span>}
                          {mp?.error && <span className="mp-err">Error: {mp.error}</span>}
                          {mp?.data && (
                            <div>
                              {mp.data.org ? (
                                <>
                                  <div className="mp-org">{mp.data.org.nombre}</div>
                                  <div className="mp-sub">Cód: {mp.data.org.codigo} · {mp.data.org.fuente}</div>
                                </>
                              ) : <div className="mp-sub">Organismo no encontrado en MP</div>}
                              {mp.data.oc?.responsable_nombre && (
                                <>
                                  <div className="mp-resp">👤 {mp.data.oc.responsable_nombre}</div>
                                  {mp.data.oc.responsable_email && <div className="mp-email">{mp.data.oc.responsable_email}</div>}
                                  {mp.data.oc.responsable_fono && <div className="mp-sub">📞 {mp.data.oc.responsable_fono}</div>}
                                </>
                              )}
                              {mp.data.oc?.comprador_unidad && !mp.data.oc?.responsable_nombre && (
                                <div className="mp-sub">Unidad: {mp.data.oc.comprador_unidad}</div>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    ) : (
                      <tr key={i}>
                        <td className="nm">{r.filename}</td>
                        <td colSpan={16} className="err-row">Error: {r.error}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
 
        <div className="footer"><a href="https://www.vantrustcapital.cl" target="_blank">vantrustcapital.cl</a></div>
      </div>
    </>
  );
}
