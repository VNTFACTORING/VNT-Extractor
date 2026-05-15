import { useState, useRef } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';

export default function Home() {
  const [files, setFiles] = useState([]);
  const [results, setResults] = useState([]);
  const [processing, setProcessing] = useState(false);
  const [processingMP, setProcessingMP] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [progressMP, setProgressMP] = useState({ current: 0, total: 0 });
  const [statuses, setStatuses] = useState({});
  const [mpData, setMpData] = useState({});
  const [over, setOver] = useState(false);
  const inputRef = useRef();

  const [vencDias, setVencDias] = useState('30');
  const [vencBase, setVencBase] = useState('hoy');

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function normalizeRut(rut) {
    if (!rut) return rut;
    let r = String(rut).trim().replace(/\./g, '').toUpperCase();
    if (!r.includes('-') && r.length > 1) r = r.slice(0, -1) + '-' + r.slice(-1);
    return r;
  }

  function calcularVencimiento(fechaEmision) {
    const dias = parseInt(vencDias, 10);
    if (isNaN(dias) || dias <= 0) return null;
    let base;
    if (vencBase === 'hoy') {
      base = new Date();
    } else {
      if (!fechaEmision) return null;
      const [dd, mm, yyyy] = fechaEmision.split('/');
      base = new Date(`${yyyy}-${mm}-${dd}`);
      if (isNaN(base.getTime())) return null;
    }
    base.setDate(base.getDate() + dias);
    const d = String(base.getDate()).padStart(2, '0');
    const m = String(base.getMonth() + 1).padStart(2, '0');
    const y = base.getFullYear();
    return `${d}/${m}/${y}`;
  }

  function getVencimiento(data) {
    const calculada = calcularVencimiento(data.fecha_emision);
    return calculada || data.fecha_vencimiento || data.fecha_emision || '';
  }

  // ── Tipos de archivo permitidos ──────────────────────────────────────────
  const TIPOS_VALIDOS = ['application/pdf','image/png','image/jpeg','image/webp'];
  const EXT_VALIDAS   = ['.pdf','.png','.jpg','.jpeg','.webp'];

  function esArchivoValido(nombre, tipo) {
    if (tipo && TIPOS_VALIDOS.includes(tipo)) return true;
    const ext = nombre.toLowerCase().slice(nombre.lastIndexOf('.'));
    return EXT_VALIDAS.includes(ext);
  }

  // ── Descomprime un ZIP y retorna los archivos válidos como File objects ──
  async function expandirZip(zipFile) {
    const zip = await JSZip.loadAsync(zipFile);
    const archivos = [];
    const promesas = [];
    zip.forEach((ruta, entry) => {
      if (entry.dir) return;
      const nombre = ruta.split('/').pop();
      if (!nombre || nombre.startsWith('.')) return;
      if (!esArchivoValido(nombre, '')) return;
      promesas.push(
        entry.async('blob').then(blob => {
          const ext  = nombre.toLowerCase().slice(nombre.lastIndexOf('.'));
          const mime = ext === '.pdf'  ? 'application/pdf'
                     : ext === '.png'  ? 'image/png'
                     : ext === '.webp' ? 'image/webp'
                     : 'image/jpeg';
          archivos.push(new File([blob], nombre, { type: mime }));
        })
      );
    });
    await Promise.all(promesas);
    return archivos;
  }

  async function addFiles(newFiles) {
    const existing = new Set(files.map(f => f.name + f.size));
    let expandidos = [];
    for (const f of [...newFiles]) {
      const esZip = f.type === 'application/zip' || f.type === 'application/x-zip-compressed' || f.name.toLowerCase().endsWith('.zip');
      if (esZip) {
        try {
          const dentro = await expandirZip(f);
          expandidos.push(...dentro);
        } catch {
          // ZIP inválido — ignorar silenciosamente
        }
      } else if (esArchivoValido(f.name, f.type)) {
        expandidos.push(f);
      }
    }
    const nuevos = expandidos.filter(f => !existing.has(f.name + f.size));
    setFiles(prev => [...prev, ...nuevos]);
    setResults([]); setStatuses({}); setMpData({});
  }

  // ── Detecta duplicados en allResults (mismo folio + rut_deudor) ──────────
  function marcarDuplicados(allResults) {
    const vistos = new Map();
    return allResults.map(r => {
      if (!r.ok || r.data?.tipo_invalido) return r;
      const key = `${(r.data.numero_folio||'').trim()}__${(r.data.rut_deudor||'').trim()}`;
      if (!key || key === '__') return r;
      if (vistos.has(key)) {
        return { ...r, duplicado: true, duplicadoDe: vistos.get(key) };
      }
      vistos.set(key, r.filename);
      return r;
    });
  }

  // ── Vincula documentos de respaldo con sus facturas por codigo_respaldo ──
  function vincularRespaldos(allResults) {
    // Normaliza código para comparación — quita espacios extra y unifica separadores
    function normCod(s) {
      return (s || '').trim().toUpperCase()
        .replace(/\s+/g, '-')   // espacios → guión
        .replace(/-+/g, '-')    // múltiples guiones → uno
        .replace(/[()]/g, '');  // quitar paréntesis
    }

    const respaldos = allResults.filter(r => r.ok && r.data?.tipo_invalido && r.data?.codigo_respaldo);

    // Construir mapa de respaldos: codigo_normalizado → [filenames]
    const mapaRespaldos = new Map();
    respaldos.forEach(r => {
      const cod = normCod(r.data.codigo_respaldo);
      if (!cod) return;
      if (!mapaRespaldos.has(cod)) mapaRespaldos.set(cod, []);
      mapaRespaldos.get(cod).push(r.filename);
    });

    // Marcar cada factura si tiene respaldo vinculado
    return allResults.map(r => {
      if (!r.ok || r.data?.tipo_invalido) return r;
      const refOC  = normCod(r.data.ref_oc);
      const refEDP = normCod(r.data.ref_edp);
      const refPre = normCod(r.data.ref_presupuesto);
      const refCon = normCod(r.data.ref_contrato);
      const refHES = normCod(r.data.ref_hes);
      const refNP  = normCod(r.data.ref_nota_pedido);
      const refs   = [refOC, refEDP, refPre, refHES, refCon, refNP].filter(Boolean);
      const tieneRespaldo = refs.some(ref => mapaRespaldos.has(ref));
      const archivosRespaldo = refs.flatMap(ref => mapaRespaldos.get(ref) || []);
      // Mapa por campo para saber cuál referencia específica tiene respaldo
      const respaldoPorCampo = {
        ref_oc:          refOC  && mapaRespaldos.has(refOC),
        ref_edp:         refEDP && mapaRespaldos.has(refEDP),
        ref_presupuesto: refPre && mapaRespaldos.has(refPre),
        ref_hes:         refHES && mapaRespaldos.has(refHES),
        ref_contrato:    refCon && mapaRespaldos.has(refCon),
        ref_nota_pedido: refNP  && mapaRespaldos.has(refNP),
      };
      return { ...r, tieneRespaldo, archivosRespaldo, respaldoPorCampo };
    });
  }

  function clearAll() {
    setFiles([]); setResults([]); setStatuses({});
    setProgress({ current: 0, total: 0 });
    setProgressMP({ current: 0, total: 0 });
    setMpData({});
  }

  function removeFile(i) {
    setFiles(prev => prev.filter((_, idx) => idx !== i));
    setResults([]); setStatuses({}); setMpData({});
  }

  // ── Genera PDF unificado con facturas y respaldos ordenados ──────────────
  async function generarPDFRespaldos() {
    const facturas = results.filter(r => r.ok && !r.data?.tipo_invalido && !r.duplicado);
    if (!facturas.length) return;

    // Normalización local igual que vincularRespaldos
    function normCodLocal(s) {
      return (s || '').trim().toUpperCase()
        .replace(/\s+/g, '-').replace(/-+/g, '-').replace(/[()]/g, '');
    }

    // Nombre del archivo — usar razón social del primer deudor
    const razonSocial = (facturas[0]?.data?.razon_social_deudor || 'CLIENTE')
      .toUpperCase().replace(/[^A-Z0-9 ]/g, '').replace(/\s+/g, '_').slice(0, 40);
    const nombreArchivo = `FA_RESPALDOS_${razonSocial}.pdf`;

    // Mapa de archivos originales por nombre
    const archivosPorNombre = new Map();
    files.forEach(f => archivosPorNombre.set(f.name, f));

    // Construir orden de documentos:
    // Facturas ordenadas por folio → cada una seguida de sus respaldos
    // Respaldos sin factura al final ordenados por nombre
    const respaldosSinVincular = new Set();
    results
      .filter(r => r.ok && r.data?.tipo_invalido)
      .forEach(r => respaldosSinVincular.add(r.filename));

    const orden = [];
    const respaldosVinculados = new Set();

    const facturasOrdenadas = [...facturas].sort((a, b) => {
      const fa = parseInt(a.data.numero_folio) || 0;
      const fb = parseInt(b.data.numero_folio) || 0;
      return fa - fb;
    });

    for (const r of facturasOrdenadas) {
      orden.push({ filename: r.filename, tipo: 'factura' });
      // Agregar respaldos vinculados ordenados por campo (OC → Pres → EDP → Cont → NP)
      const camposOrden = ['ref_oc','ref_presupuesto','ref_edp','ref_hes','ref_contrato','ref_nota_pedido'];
      for (const campo of camposOrden) {
        if (r.respaldoPorCampo?.[campo]) {
          const refVal = normCodLocal(r.data[campo]);
          results
            .filter(rb => rb.ok && rb.data?.tipo_invalido && normCodLocal(rb.data?.codigo_respaldo) === refVal)
            .forEach(rb => {
              // Permitir repetición — una OC puede vincularse a múltiples facturas
              orden.push({ filename: rb.filename, tipo: 'respaldo' });
              respaldosVinculados.add(rb.filename);
            });
        }
      }
    }

    // Respaldos sin factura vinculada al final, ordenados por nombre
    const respaldosSinVincularFinal = results
      .filter(r => r.ok && r.data?.tipo_invalido && !respaldosVinculados.has(r.filename))
      .sort((a, b) => a.filename.localeCompare(b.filename));
    respaldosSinVincularFinal.forEach(r => orden.push({ filename: r.filename, tipo: 'respaldo' }));

    // Crear PDF unificado
    const pdfDoc = await PDFDocument.create();

    for (const item of orden) {
      const archivo = archivosPorNombre.get(item.filename);
      if (!archivo) continue;

      const ext = item.filename.toLowerCase().slice(item.filename.lastIndexOf('.'));
      const bytes = await archivo.arrayBuffer();

      try {
        if (ext === '.pdf') {
          // Embeber PDF directamente
          const srcDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
          const paginas = await pdfDoc.copyPages(srcDoc, srcDoc.getPageIndices());
          paginas.forEach(p => pdfDoc.addPage(p));
        } else {
          // Convertir imagen a página PDF — tamaño A4 para uniformidad y menor peso
          const page = pdfDoc.addPage([595, 842]); // A4
          let img;
          if (ext === '.png') {
            img = await pdfDoc.embedPng(bytes);
          } else {
            img = await pdfDoc.embedJpg(bytes);
          }
          const { width, height } = img.scaleToFit(575, 822);
          page.drawImage(img, {
            x: (595 - width) / 2,
            y: (842 - height) / 2,
            width,
            height,
          });
        }
      } catch {
        // Si un archivo falla, continuar con el siguiente
        continue;
      }
    }

    // Descargar
    const pdfBytes = await pdfDoc.save();
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = nombreArchivo;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function toB64(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result.split(',')[1]);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
  }

  async function consultarMP(rowIndex, rut_deudor, razon_social_deudor, ref_oc, ref_presupuesto, ref_edp, folio) {
    try {
      const res = await fetch('/api/mercadopublico', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rut_deudor, razon_social_deudor, ref_oc, ref_presupuesto, ref_edp, folio })
      });
      const data = await res.json();
      setMpData(prev => ({ ...prev, [rowIndex]: { loading: false, data } }));
    } catch (e) {
      setMpData(prev => ({ ...prev, [rowIndex]: { loading: false, error: e.message } }));
    }
  }

  async function consultarMPTodas(allResults) {
    const okRows = allResults.map((r, i) => ({ r, i })).filter(({ r }) => r.ok);
    if (!okRows.length) return;
    setProcessingMP(true);
    setProgressMP({ current: 0, total: okRows.length });
    const loadingState = {};
    okRows.forEach(({ i }) => { loadingState[i] = { loading: true }; });
    setMpData(loadingState);
    for (let idx = 0; idx < okRows.length; idx++) {
      const { r, i } = okRows[idx];
      setProgressMP({ current: idx + 1, total: okRows.length });
      await consultarMP(i, r.data.rut_deudor, r.data.razon_social_deudor, r.data.ref_oc, r.data.ref_presupuesto, r.data.ref_edp, r.data.numero_folio);
      if (idx < okRows.length - 1) await sleep(1200);
    }
    setProcessingMP(false);
  }

  async function extract() {
    if (!files.length || processing) return;
    const dias = parseInt(vencDias, 10);
    if (isNaN(dias) || dias <= 0) {
      alert('Debes ingresar un número de días de vencimiento válido antes de extraer.');
      return;
    }
    setProcessing(true);
    setResults([]); setMpData({});
    const ns = {}; files.forEach((_, i) => { ns[i] = 'queue'; }); setStatuses({ ...ns });
    const allResults = [];
    for (let i = 0; i < files.length; i++) {
      setProgress({ current: i + 1, total: files.length });
      setStatuses(prev => ({ ...prev, [i]: 'processing' }));
      try {
        const b64 = await toB64(files[i]);
        const ext = files[i].name.toLowerCase().slice(files[i].name.lastIndexOf('.'));
        const mimeType = ext === '.pdf'  ? 'application/pdf'
                       : ext === '.png'  ? 'image/png'
                       : ext === '.webp' ? 'image/webp'
                       : files[i].type && files[i].type !== 'application/octet-stream'
                         ? files[i].type
                         : 'image/jpeg';
        const res = await fetch('/api/extract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileData: b64, mimeType })
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
    const resultadosMarcados = marcarDuplicados(allResults);
    const resultadosFinal = vincularRespaldos(resultadosMarcados);
    setResults(resultadosFinal);
    setProcessing(false);
    // Solo consultar MP para facturas válidas, no respaldos
    await consultarMPTodas(resultadosFinal.filter(r => r.ok && !r.data.tipo_invalido && !r.duplicado));
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
    const dias = parseInt(vencDias, 10);
    if (isNaN(dias) || dias <= 0) {
      alert('Debes configurar los días de vencimiento antes de exportar.');
      return;
    }
    const ok = results.filter(r => r.ok && !r.duplicado && !r.data?.tipo_invalido);
    if (!ok.length) return;
    const hdr = ['RUTconGuión','RazonSocial','MontoDocto','FechaVenc','NumDocto'];
    const rows = ok.map(r => {
      const d = r.data;
      const venc = toDateGVE(getVencimiento(d));
      return [d.rut_deudor||'', d.razon_social_deudor||'', d.total||'', venc, d.numero_folio||''];
    });
    navigator.clipboard.writeText([hdr,...rows].map(r=>r.join('\t')).join('\n'))
      .then(()=>alert('Copiado en formato GVE (Carga Masiva)'))
      .catch(()=>alert('No se pudo copiar automáticamente.'));
  }

  function exportCompleto() {
    const ok = results
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.ok && !r.duplicado && !r.data?.tipo_invalido);
    if (!ok.length) return;
    const hdr = ['Tipo','Folio','RUT Emisor','Emisor','RUT Deudor','Deudor','F. Emisión','F. Venc.','Total','Referencias','Organismo MP','Licitación MP','Resp. Pago','Email Pago','Resp. Contrato','Email Contrato','Fono Contrato','Ejecutivo Compras','Unidad'];
    const rows = ok.map(({ r, i }) => {
      const d = r.data;
      const mp = mpData[i]?.data;
      const refs = [
        d.ref_oc           ? `OC: ${d.ref_oc}`         : null,
        d.ref_presupuesto  ? `Pres: ${d.ref_presupuesto}` : null,
        d.ref_edp          ? `EDP: ${d.ref_edp}`        : null,
        d.ref_hes          ? `HES: ${d.ref_hes}`        : null,
        d.ref_contrato     ? `Cont: ${d.ref_contrato}`  : null,
        d.ref_nota_pedido  ? `NP: ${d.ref_nota_pedido}` : null,
      ].filter(Boolean).join(' | ') || '—';
      return [
        d.tipo_documento||'', d.numero_folio||'',
        d.rut_emisor||'', d.razon_social_emisor||'',
        d.rut_deudor||'', d.razon_social_deudor||'',
        d.fecha_emision||'', getVencimiento(d),
        d.total||'', refs,
        mp?.licitacion?.organismo||mp?.org?.nombre||'',
        mp?.licitacion?.codigo||'',
        mp?.licitacion?.responsable_pago||'',
        mp?.licitacion?.email_pago||'',
        mp?.licitacion?.responsable_contrato||'',
        mp?.licitacion?.email_contrato||'',
        mp?.licitacion?.fono_contrato||'',
        mp?.licitacion?.ejecutivo_compras||'',
        mp?.licitacion?.unidad||'',
      ];
    });
    navigator.clipboard.writeText([hdr,...rows].map(r=>r.join('\t')).join('\n'))
      .then(()=>alert('Copiado completo'))
      .catch(()=>alert('No se pudo copiar.'));
  }

  const okResults = results.filter(r => r.ok && !r.duplicado && !r.data?.tipo_invalido);
  const totalNeto = okResults.reduce((s, r) => s + (r.data.monto_neto || 0), 0);
  const totalFinal = okResults.reduce((s, r) => s + (r.data.total || 0), 0);
  const mpDone = Object.values(mpData).filter(m => !m.loading).length;
  const mpTotal = Object.keys(mpData).length;

  const statusLabel = { queue:'En cola', processing:'Procesando…', done:'✓ Listo', error:'Error' };
  const statusColor = { queue:'#6B7A8D', processing:'#1A6AB5', done:'#0A7055', error:'#C00000' };
  const statusBg   = { queue:'#F2F4F7', processing:'#E8F4FF', done:'#E1F5EE', error:'#FFF0F0' };

  const diasValido = !isNaN(parseInt(vencDias, 10)) && parseInt(vencDias, 10) > 0;
  const baseLabel = vencBase === 'hoy' ? 'fecha de hoy' : 'fecha de emisión';

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
        .nav-link { font-size:13px; font-weight:500; color:rgba(255,255,255,.45); text-decoration:none; padding-bottom:4px; transition:color .15s; }
        .nav-link:hover { color:rgba(255,255,255,.8); }
        .nav-link.active { color:#fff; font-weight:600; border-bottom:2px solid #2AADB8; }
        .page { max-width:1300px; margin:0 auto; padding:2rem 1.5rem 4rem; }
        .venc-panel { background:#fff; border:1px solid #DDE2EA; border-radius:14px; padding:1.125rem 1.25rem; margin-bottom:1rem; }
        .venc-header { display:flex; align-items:center; gap:8px; margin-bottom:.875rem; }
        .venc-title { font-size:13px; font-weight:600; color:#1A2B3C; }
        .venc-badge-ok { font-size:10px; font-weight:700; padding:2px 8px; border-radius:20px; background:#E1F5EE; color:#0A7055; }
        .venc-badge-warn { font-size:10px; font-weight:700; padding:2px 8px; border-radius:20px; background:#FFF3CD; color:#856404; }
        .venc-body { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
        .venc-field { display:flex; align-items:center; gap:8px; }
        .venc-label { font-size:12px; color:#6B7A8D; white-space:nowrap; }
        .venc-input { width:72px; padding:7px 10px; border:1px solid #DDE2EA; border-radius:8px; font-size:14px; font-weight:600; font-family:'DM Mono',monospace; color:#1A2B3C; background:#F8FAFB; text-align:center; outline:none; transition:border .15s; }
        .venc-input:focus { border-color:#2AADB8; background:#fff; }
        .venc-input.invalid { border-color:#C00000; background:#FFF0F0; }
        .venc-sep { color:#DDE2EA; font-size:18px; }
        .venc-tabs { display:flex; border:1px solid #DDE2EA; border-radius:8px; overflow:hidden; }
        .venc-tab { padding:7px 14px; font-size:12px; font-weight:500; font-family:'DM Sans',sans-serif; border:none; cursor:pointer; transition:all .15s; background:#F8FAFB; color:#6B7A8D; }
        .venc-tab.active { background:#1A2B3C; color:#fff; }
        .venc-tab:first-child { border-right:1px solid #DDE2EA; }
        .venc-preview { font-size:12px; color:#6B7A8D; margin-left:4px; }
        .venc-preview strong { color:#1A2B3C; font-weight:600; font-family:'DM Mono',monospace; }
        .venc-default { font-size:11px; color:#2AADB8; cursor:pointer; text-decoration:underline; margin-left:auto; white-space:nowrap; }
        .venc-default:hover { color:#1F8A94; }
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
        .prog { margin-bottom:.75rem; }
        .prog-label { font-size:12px; color:#6B7A8D; margin-bottom:6px; display:flex; align-items:center; gap:8px; }
        .prog-label .badge { font-size:10px; font-weight:700; padding:2px 8px; border-radius:20px; }
        .badge-extract { background:#E8F4FF; color:#1A6AB5; }
        .badge-mp { background:#F0EEFF; color:#5B2ED8; }
        .prog-bar { height:6px; background:#DDE2EA; border-radius:6px; overflow:hidden; margin-bottom:.5rem; }
        .prog-fill { height:100%; border-radius:6px; transition:width .4s ease; }
        .prog-fill.extract { background:#2AADB8; }
        .prog-fill.mp { background:#7C3AED; }
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
        .btn-exp-gve:disabled { opacity:.4; cursor:not-allowed; }
        .btn-exp-full { display:inline-flex; align-items:center; gap:6px; padding:9px 18px; background:#fff; color:#1A2B3C; font-size:13px; font-weight:600; font-family:'DM Sans',sans-serif; border:1px solid #DDE2EA; border-radius:8px; cursor:pointer; }
        .btn-exp-full:hover { background:#F2F4F7; }
        .btn-exp-pdf { display:inline-flex; align-items:center; gap:6px; padding:9px 18px; background:#E1F5EE; color:#0A7055; font-size:13px; font-weight:600; font-family:'DM Sans',sans-serif; border:1px solid #0A7055; border-radius:8px; cursor:pointer; }
        .btn-exp-pdf:hover { background:#0A7055; color:#fff; }
        .tbl-wrap { background:#fff; border:1px solid #DDE2EA; border-radius:14px; overflow:auto; }
        table { width:100%; border-collapse:collapse; min-width:1400px; }
        thead th { padding:10px 14px; text-align:left; font-size:10px; font-weight:700; color:#6B7A8D; text-transform:uppercase; letter-spacing:.07em; background:#F2F4F7; border-bottom:1px solid #DDE2EA; white-space:nowrap; }
        thead th.gve { background:#E6F7F9; color:#1F8A94; }
        thead th.ref { background:#FFF8E6; color:#A67700; }
        thead th.mp  { background:#F0EEFF; color:#5B2ED8; }
        thead th.venc-col { background:#E8F4FF; color:#1A6AB5; }
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
        .ref-cell { min-width:160px; vertical-align:top; }
        .venc-calc { font-weight:700; color:#1A6AB5; }
        .mp-cell { min-width:220px; font-family:'DM Sans',sans-serif; }
        .mp-loading { font-size:11px; color:#7C3AED; display:flex; align-items:center; gap:6px; }
        .mp-spinner { width:12px; height:12px; border:2px solid #DDD; border-top-color:#7C3AED; border-radius:50%; animation:spin .7s linear infinite; }
        @keyframes spin { to { transform:rotate(360deg); } }
        .mp-org { font-size:12px; font-weight:600; color:#5B2ED8; }
        .mp-licit { font-size:10px; color:#7C3AED; margin-top:1px; font-family:'DM Mono',monospace; }
        .mp-resp { font-size:12px; font-weight:600; color:#1A2B3C; margin-top:5px; }
        .mp-cargo { font-size:11px; color:#6B7A8D; }
        .mp-email { font-size:11px; color:#1A6AB5; font-family:'DM Mono',monospace; }
        .mp-fono { font-size:11px; color:#6B7A8D; }
        .mp-none { font-size:11px; color:#DDE2EA; }
        .mp-nota { font-size:10px; color:#A67700; margin-top:3px; font-style:italic; }
        .mp-err { font-size:11px; color:#C00000; }
        .dup-row { background:#FFF5F5 !important; }
        .dup-badge { display:inline-flex; align-items:center; gap:5px; padding:3px 10px; background:#FFF0F0; color:#C00000; font-size:11px; font-weight:700; border:1px solid #FFCDD2; border-radius:20px; }
        .respaldo-ok { font-size:13px; cursor:default; }
        .respaldo-no { font-size:13px; cursor:default; opacity:.5; }
        .btn-oc { display:inline-flex; align-items:center; gap:5px; padding:5px 10px; background:#E6F7F9; color:#1F8A94; font-size:11px; font-weight:600; font-family:'DM Sans',sans-serif; border:1px solid #2AADB8; border-radius:6px; cursor:pointer; text-decoration:none; white-space:nowrap; }
        .btn-oc:hover { background:#2AADB8; color:#fff; }
        .footer { text-align:center; padding:2rem 0 1rem; font-size:11px; color:#6B7A8D; }
        .footer a { color:#2AADB8; text-decoration:none; }
        @media(max-width:500px){ .summary{grid-template-columns:1fr;} .venc-body{flex-direction:column;align-items:flex-start;} }
      `}</style>

      <div className="top">
        <div className="dots">
          <div className="dot dim"/><div className="dot"/><div className="dot dim"/>
          <div className="dot"/><div className="dot"/><div className="dot"/>
          <div className="dot dim"/><div className="dot"/><div className="dot dim"/>
        </div>
        <span className="brand">Van<span>Trust</span> Capital</span>
        <span className="sep">|</span>
        <Link href="/" className="nav-link active">Extractor</Link>
        <Link href="/contactos" className="nav-link">Contactos MP</Link>
      </div>

      <div className="page">
        <input ref={inputRef} type="file" accept=".pdf,.zip,image/png,image/jpeg,image/webp" multiple style={{display:'none'}}
          onChange={e => { addFiles(e.target.files); e.target.value=''; }} />

        <div className="venc-panel">
          <div className="venc-header">
            <span className="venc-title">📅 Fecha de vencimiento</span>
            {diasValido
              ? <span className="venc-badge-ok">✓ Configurado</span>
              : <span className="venc-badge-warn">⚠ Requerido</span>
            }
            {!(vencDias === '30' && vencBase === 'hoy') && (
              <span className="venc-default" onClick={() => { setVencDias('30'); setVencBase('hoy'); }}>
                Usar recomendado (30 días desde hoy)
              </span>
            )}
          </div>
          <div className="venc-body">
            <div className="venc-field">
              <span className="venc-label">Días de vencimiento</span>
              <input
                className={`venc-input${!diasValido ? ' invalid' : ''}`}
                type="number" min="1" max="365"
                value={vencDias}
                onChange={e => setVencDias(e.target.value)}
                placeholder="30"
              />
            </div>
            <span className="venc-sep">·</span>
            <div className="venc-field">
              <span className="venc-label">A partir de</span>
              <div className="venc-tabs">
                <button className={`venc-tab${vencBase==='hoy'?' active':''}`} onClick={() => setVencBase('hoy')}>Fecha de hoy</button>
                <button className={`venc-tab${vencBase==='emision'?' active':''}`} onClick={() => setVencBase('emision')}>Fecha de emisión</button>
              </div>
            </div>
            {diasValido && (
              <span className="venc-preview">
                → vence a <strong>{vencDias} días</strong> desde la {baseLabel}
              </span>
            )}
          </div>
        </div>

        <div className={`drop${files.length?' has':''}${over?' over':''}`}
          onClick={() => inputRef.current.click()}
          onDragOver={e => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={e => { e.preventDefault(); setOver(false); addFiles(e.dataTransfer.files); }}>
          <div className="drop-icon">{files.length ? '📂' : '📄'}</div>
          <div className="drop-title">{files.length ? `${files.length} factura${files.length>1?'s':''} lista${files.length>1?'s':''}` : 'Arrastra las facturas aquí'}</div>
          <div className="drop-sub">{files.length ? 'Clic para agregar más archivos' : 'Puedes subir varias a la vez · PDF o imagen'}</div>
          <div className="fmts"><span className="fmt">PDF</span><span className="fmt">PNG / JPG</span><span className="fmt">ZIP</span><span className="fmt">Múltiples archivos</span></div>
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
                {!processing && !processingMP && (
                  <button
                    className="qi-rm"
                    onClick={e => { e.stopPropagation(); removeFile(i); }}
                  >×</button>
                )}
              </div>
            ))}
          </div>
        )}

        {files.length > 0 && (
          <div className="actions">
            <button className="btn-main" onClick={extract} disabled={processing || processingMP}>
              {processing
                ? `Extrayendo ${progress.current} de ${progress.total}…`
                : processingMP
                  ? `Consultando Mercado Público ${progressMP.current} de ${progressMP.total}…`
                  : '⬇ Extraer datos'}
            </button>
            {!processing && !processingMP && <button className="btn-sec" onClick={clearAll}>Limpiar</button>}
          </div>
        )}

        {processing && (
          <div className="prog">
            <div className="prog-label">
              <span className="badge badge-extract">EXTRACCIÓN</span>
              Procesando factura {progress.current} de {progress.total}
            </div>
            <div className="prog-bar"><div className="prog-fill extract" style={{width:`${(progress.current/progress.total)*100}%`}}/></div>
          </div>
        )}

        {processingMP && (
          <div className="prog">
            <div className="prog-label">
              <span className="badge badge-mp">MERCADO PÚBLICO</span>
              Consultando responsables {progressMP.current} de {progressMP.total}
            </div>
            <div className="prog-bar"><div className="prog-fill mp" style={{width:`${(progressMP.current/progressMP.total)*100}%`}}/></div>
          </div>
        )}

        {!processingMP && mpTotal > 0 && !processing && (
          <div style={{fontSize:12, color:'#5B2ED8', marginBottom:'.75rem', display:'flex', alignItems:'center', gap:6}}>
            ✓ Mercado Público: {mpDone}/{mpTotal} consultadas
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
                  <button className="btn-exp-gve" onClick={exportGVE} disabled={!diasValido}>⬇ Exportar GVE (Carga Masiva)</button>
                  <button className="btn-exp-full" onClick={exportCompleto}>⬇ Exportar completo + MP</button>
                  {results.some(r => r.ok && !r.data?.tipo_invalido && !r.duplicado && r.tieneRespaldo) && (
                    <button className="btn-exp-pdf" onClick={generarPDFRespaldos}>📄 Descargar respaldos ordenados</button>
                  )}
                </div>
              )}
            </div>
            <div className="tbl-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Tipo</th><th>Folio</th>
                    <th className="gve">RUT Emisor</th><th>Emisor</th>
                    <th className="gve">RUT Deudor</th><th>Deudor</th>
                    <th>F. Emisión</th>
                    <th className="venc-col">F. Venc. ({diasValido ? `+${vencDias}d` : '?'})</th>
                    <th className="gve">Total</th>
                    <th className="ref">Referencias</th>
                    <th className="ref">Ver OC</th>
                    <th className="mp">Responsable MP</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r, i) => {
                    if (r.data?.tipo_invalido) return null;
                    const mp = mpData[i];
                    const lit = mp?.data?.licitacion;
                    return r.ok ? (
                      <tr key={i} className={r.duplicado ? 'dup-row' : ''}>
                        <td>{fmt(r.data.tipo_documento)}</td>
                        <td style={{fontWeight:600}}>
                          {fmt(r.data.numero_folio)}
                          {r.duplicado && (
                            <div style={{marginTop:4}}>
                              <span className="dup-badge">⚠ Duplicado de {r.duplicadoDe}</span>
                            </div>
                          )}
                        </td>
                        <td className={r.data.confianza?.rut_emisor==='baja'?'conf-baja':''}>{fmt(r.data.rut_emisor)}</td>
                        <td>{fmt(r.data.razon_social_emisor)}</td>
                        <td className={r.data.confianza?.rut_deudor==='baja'?'conf-baja':''}>{fmt(r.data.rut_deudor)}</td>
                        <td>{fmt(r.data.razon_social_deudor)}</td>
                        <td>{fmt(r.data.fecha_emision)}</td>
                        <td className="venc-calc" style={{fontWeight:700}}>{diasValido ? fmt(getVencimiento(r.data)) : <span style={{color:'#DDE2EA'}}>—</span>}</td>
                        <td className="total-m">{fmt(r.data.total, true)}</td>
                        <td className="ref-cell">
                          {(() => {
                            const refs = [
                              { campo: 'ref_oc',          label: 'OC',   val: r.data.ref_oc },
                              { campo: 'ref_presupuesto', label: 'Pres', val: r.data.ref_presupuesto },
                              { campo: 'ref_edp',         label: 'EDP',  val: r.data.ref_edp },
                              { campo: 'ref_hes',         label: 'HES',  val: r.data.ref_hes },
                              { campo: 'ref_contrato',    label: 'Cont', val: r.data.ref_contrato },
                              { campo: 'ref_nota_pedido', label: 'NP',   val: r.data.ref_nota_pedido },
                            ].filter(x => x.val);
                            if (!refs.length) return <span style={{color:'#DDE2EA'}}>Sin referencia</span>;
                            return refs.map((x, ri) => (
                              <div key={ri} style={{marginBottom: ri < refs.length-1 ? 3 : 0}}>
                                <span style={{color:'#6B7A8D', fontSize:10}}>{x.label}: </span>
                                <span className="ref-val">{x.val}</span>
                                {' '}
                                <span
                                  className={r.respaldoPorCampo?.[x.campo] ? 'respaldo-ok' : 'respaldo-no'}
                                  title={r.respaldoPorCampo?.[x.campo] ? `Respaldo adjunto` : 'Sin respaldo adjunto'}
                                >
                                  {r.respaldoPorCampo?.[x.campo] ? '✅' : '❌'}
                                </span>
                              </div>
                            ));
                          })()}
                        </td>
                        <td>
                          {r.data.ref_oc && /^\d+-\d+/i.test(r.data.ref_oc) ? (
                            <a
                              className="btn-oc"
                              href={`https://www.mercadopublico.cl/PurchaseOrder/Modules/PO/DetailsPurchaseOrder.aspx?codigoOC=${encodeURIComponent(r.data.ref_oc)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              📄 Ver OC
                            </a>
                          ) : <span style={{color:'#DDE2EA'}}>—</span>}
                        </td>
                        <td className="mp-cell">
                          {mp?.loading && <div className="mp-loading"><div className="mp-spinner"/>Consultando MP…</div>}
                          {mp?.error && (
                            <div style={{display:'flex',flexDirection:'column',gap:4}}>
                              <span className="mp-err">Error: {mp.error}</span>
                              <button onClick={() => consultarMP(i, r.data.rut_deudor, r.data.razon_social_deudor, r.data.ref_oc, r.data.ref_presupuesto, r.data.ref_edp, r.data.numero_folio)}>🔄 Reintentar</button>
                            </div>
                          )}
                          {!mp && !processingMP && (
                            <button onClick={() => consultarMP(i, r.data.rut_deudor, r.data.razon_social_deudor, r.data.ref_oc, r.data.ref_presupuesto, r.data.ref_edp, r.data.numero_folio)}>🔍 Buscar</button>
                          )}
                          {mp?.data && !mp.loading && (
                            <div>
                              {!mp.data.licitacion && !mp.data.org && (
                                <div style={{display:'flex',flexDirection:'column',gap:4}}>
                                  <span className="mp-none">No encontrado en MP</span>
                                  <button onClick={() => consultarMP(i, r.data.rut_deudor, r.data.razon_social_deudor, r.data.ref_oc, r.data.ref_presupuesto, r.data.ref_edp, r.data.numero_folio)}>🔄 Reintentar</button>
                                </div>
                              )}
                              {lit ? (
                                <>
                                  <div className="mp-org">{lit.organismo || mp.data.org?.nombre || '—'}</div>
                                  <div className="mp-licit">📋 {lit.codigo} · {lit.unidad}</div>
                                  {lit.responsable_pago && (
                                    <>
                                      <div className="mp-resp">💰 {lit.responsable_pago}</div>
                                      {lit.email_pago && <div className="mp-email">{lit.email_pago}</div>}
                                    </>
                                  )}
                                  {lit.responsable_contrato && (
                                    <>
                                      <div className="mp-resp" style={{marginTop:3}}>📝 {lit.responsable_contrato}</div>
                                      {lit.email_contrato && <div className="mp-email">{lit.email_contrato}</div>}
                                      {lit.fono_contrato && <div className="mp-fono">📞 {lit.fono_contrato}</div>}
                                    </>
                                  )}
                                  {lit.ejecutivo_compras && <div className="mp-cargo" style={{marginTop:3}}>🛒 {lit.ejecutivo_compras}</div>}
                                  {lit.nota && <div className="mp-nota">⚠️ {lit.nota}</div>}
                                </>
                              ) : mp.data.org ? (
                                <>
                                  <div className="mp-org">{mp.data.org.nombre}</div>
                                  <div className="mp-none">Sin licitación con responsable</div>
                                </>
                              ) : null}
                            </div>
                          )}
                        </td>
                      </tr>
                    ) : (
                      <tr key={i}>
                        <td colSpan={12} className="err-row">{r.filename} — Error: {r.error}</td>
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
