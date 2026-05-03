// AURA. -- storefront/parts/toast.js
// Toast notifications (showToast).
'use strict';

module.exports = `
var toastT;
function showToast(msg){clearTimeout(toastT);var t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');toastT=setTimeout(function(){t.classList.remove('show');},2400);}
`;
