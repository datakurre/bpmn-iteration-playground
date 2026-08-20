// BPMN Pi Workflow Common Utilities
window.$ = id => document.getElementById(id);

window.escapeHtml = function(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
};

window.toggleAcc = function(elOrId) {
  let header, content;
  if (typeof elOrId === 'string') {
    content = $(elOrId);
    header = content ? content.previousElementSibling : null;
  } else {
    header = elOrId;
    content = header.nextElementSibling;
  }
  if (!content) return;
  const isHidden = content.classList.toggle('hidden');
  if (header) {
    const icon = header.querySelector('.acc-icon') || header.querySelector('.acc-chevron');
    if (icon) {
      icon.style.transform = isHidden ? 'rotate(0deg)' : 'rotate(180deg)';
    }
    header.setAttribute('aria-expanded', String(!isHidden));
  }
};

window.handleAccKey = function(event, el) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    window.toggleAcc(el);
  }
};

window.formatDate = function(isoStr) {
  if (!isoStr) return '-';
  try {
    const d = new Date(isoStr);
    return isNaN(d.getTime()) ? isoStr : d.toLocaleString();
  } catch (e) {
    return isoStr;
  }
};
