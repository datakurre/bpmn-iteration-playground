"use strict";(()=>{function a(t){return document.getElementById(t)}function u(t,n,s,c=""){t.innerHTML=n.length?n.map(s).join(""):c}function o(t){return t==null?"":String(t).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;")}var p="all",i=[],r=a("pack-db"),m=a("clear-all");async function g(){try{let t=await fetch("/api/history/storage");if(t.ok){let n=await t.json(),s=a("m-storage");s&&(s.textContent=n.size_human)}}catch{}}async function d(){g();let t=await fetch("/api/history/instances");t.ok&&(i=await t.json(),h())}async function x(t){confirm("Delete this historical instance?")&&(await fetch("/api/history/instances/"+encodeURIComponent(t),{method:"DELETE"})).ok&&d()}r&&(r.onclick=async()=>{r.disabled=!0,r.textContent="Packing...";try{let t=await fetch("/api/history/pack",{method:"POST"});if(t.ok){let n=await t.json(),s=a("pack-status");s&&(s.classList.remove("hidden"),s.textContent=`Compacted ZODB storage: reclaimed ${n.reclaimed_human} (current size: ${n.size_after_human})`),g()}}finally{r.disabled=!1,r.textContent="Pack Database"}});var l=a("purge-terminal");l&&(l.onclick=async()=>{if(confirm("Purge all completed and cancelled workflow instances from ZODB?")){l.disabled=!0;try{let t=await fetch("/api/history/purge?status=completed,cancelled",{method:"POST"});if(t.ok){let n=await t.json(),s=a("pack-status");s&&(s.classList.remove("hidden"),s.textContent=`Purged ${n.purged} completed/cancelled workflow instances.`),d()}}finally{l.disabled=!1}}});m&&(m.onclick=async()=>{confirm("Delete all historical workflow instances?")&&(await fetch("/api/history/instances?confirm=DELETE_ALL",{method:"DELETE"})).ok&&d()});function h(){let t=i.filter(e=>p==="all"||e.status===p),n=a("m-total"),s=a("m-completed"),c=a("m-savepoints");n&&(n.textContent=String(i.length)),s&&(s.textContent=String(i.filter(e=>e.status==="completed").length)),c&&(c.textContent=String(i.reduce((e,w)=>e+(w.save_point_count||0),0)));let f=a("list");f&&u(f,t,e=>`
    <article class="bg-panel border border-line rounded-lg p-3.5 mb-2 flex flex-col md:flex-row justify-between md:items-center gap-3 hover:border-line-highlight transition-colors shadow-md ${e.parent_workflow_id?"ml-5 border-l-4 !border-l-accent":""}">
      <div>
        <div class="text-sm font-semibold text-ink">
          <a href="/history/${encodeURIComponent(e.workflow_id)}" class="text-inherit no-underline hover:text-accent transition-colors">${o(e.workflow_id)}</a>
          ${e.parent_workflow_id?'<span class="badge bg-[#2b3b51] ml-2">Subprocess</span>':""}
        </div>
        <div class="text-muted text-xs mt-1 flex gap-3 flex-wrap">
          <span>Process: <strong class="text-ink">${o(e.process_id)}</strong></span>
          ${e.parent_workflow_id?`<span>Parent: <a href="/history/${encodeURIComponent(e.parent_workflow_id)}" class="text-accent hover:underline">${o(e.parent_workflow_id.slice(0,8))}</a></span>`:""}
          <span>Tasks: <strong class="text-ink">${o(e.task_count)}</strong></span>
          <span>Save Points: <strong class="text-ink">${o(e.save_point_count)}</strong></span>
          ${e.updated_at?`<span>Updated: ${o(new Date(e.updated_at).toLocaleString())}</span>`:""}
        </div>
      </div>
      <div class="flex items-center gap-3">
        <span class="badge ${o(e.status)}">${o(e.status)}</span>
        <div class="flex items-center gap-1.5">
          <a href="/history/${encodeURIComponent(e.workflow_id)}" class="btn btn-secondary text-xs px-2.5 py-1">Inspect</a>
          <a href="/instance/${encodeURIComponent(e.workflow_id)}" class="btn text-xs px-2.5 py-1">View</a>
          <button class="btn btn-danger text-xs px-2.5 py-1" onclick="deleteHistory('${o(e.workflow_id)}')">Delete</button>
        </div>
      </div>
    </article>
  `,'<div class="text-muted text-center py-8 text-xs">No process instances match the selected filter.</div>')}document.querySelectorAll(".tab").forEach(t=>{t.onclick=()=>{document.querySelectorAll(".tab").forEach(n=>{n.classList.remove("active","text-accent","bg-accent-dim","border-accent-border"),n.classList.add("text-muted","border-line")}),t.classList.add("active","text-accent","bg-accent-dim","border-accent-border"),t.classList.remove("text-muted","border-line"),p=t.dataset.filter??"all",h()}});window.deleteHistory=x;d();})();
