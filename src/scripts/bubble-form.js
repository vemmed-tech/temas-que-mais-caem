export const BUBBLE_ENDPOINT = 'https://plano-milhoes-25.bubbleapps.io/api/1.1/wf/parceiros';

export function createBubblePayload(form, produto) {
  const value = (field) => String(form.elements.namedItem(`mauticform[${field}]`)?.value ?? '').trim();
  return {
    nome: value('nome_completo1'),
    email: value('email'),
    celular: value('telefone').replace(/\D/g, ''),
    produto,
    sobrenome: value('sobrenome'),
  };
}

export function attachBubbleSubmission(form, produto, {
  sdk = () => window.MauticSDK,
  callbacks = (window.MauticFormCallback ??= {}),
  request = window.fetch.bind(window),
} = {}) {
  if (form.dataset.bubbleIntegrated) return;
  form.dataset.bubbleIntegrated = 'true';
  const formName = form.getAttribute('data-mautic-form');
  const button = form.querySelector('button[type="submit"]');
  const error = form.querySelector('.mauticform-error');
  const fields = ['nome_completo1', 'sobrenome', 'email', 'telefone']
    .map((field) => form.elements.namedItem(`mauticform[${field}]`))
    .filter(Boolean);
  let pending = false;
  let delivered = null;
  let restoreControls = () => {};

  const showError = (message) => {
    if (!error) return;
    error.setAttribute('role', 'alert');
    error.textContent = message;
  };

  // Mautic still handles its response, success message and original redirect.
  const callback = (callbacks[formName] ??= {});
  const previousResponseEnd = callback.onResponseEnd;
  callback.onResponseEnd = function (response) {
    pending = false;
    restoreControls();
    return previousResponseEnd?.call(this, response);
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (pending) return;
    const mautic = typeof sdk === 'function' ? sdk() : sdk;
    if (!mautic || !form.reportValidity()) {
      if (!mautic) showError('O formulário ainda está carregando. Aguarde um momento e tente novamente.');
      return;
    }
    if (!mautic.validateForm(formName, false)) return;

    const payload = createBubblePayload(form, produto);
    if (!payload.nome || !payload.sobrenome || !payload.email || !/^\d{10,11}$/.test(payload.celular)) {
      showError('Confira seu nome, sobrenome, e-mail e celular com DDD antes de continuar.');
      return;
    }

    const body = JSON.stringify(payload);
    const previousReadOnly = fields.map((field) => field.readOnly);
    const previousButton = button && { disabled: button.disabled, html: button.innerHTML };
    restoreControls = () => {
      fields.forEach((field, index) => { field.readOnly = previousReadOnly[index]; });
      if (button && previousButton) {
        button.disabled = previousButton.disabled;
        button.innerHTML = previousButton.html;
      }
    };
    fields.forEach((field) => { field.readOnly = true; });
    if (button) {
      button.disabled = true;
      button.textContent = 'Enviando…';
    }
    pending = true;
    showError('');

    try {
      // A retry after a Mautic error should not duplicate a confirmed Bubble request.
      if (body !== delivered) {
        const response = await request(BUBBLE_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(20000),
        });
        if (!response.ok) throw new Error(`Bubble HTTP ${response.status}`);
        const text = await response.text();
        if (text) {
          const result = JSON.parse(text);
          if (result.status && result.status !== 'success') throw new Error('Bubble did not confirm success');
        }
        delivered = body;
      }
      // Restore the original button label before Mautic saves its submitting state.
      restoreControls();
      if (!mautic.validateForm(formName, true)) {
        pending = false;
        restoreControls();
      }
    } catch (failure) {
      pending = false;
      restoreControls();
      showError('Não foi possível concluir seu cadastro agora. Tente novamente em instantes.');
      console.error('Falha no envio ao Bubble:', failure);
    }
  }, true);
}

export function integrateBubbleForm(produto) {
  const attach = () => {
    const form = document.querySelector('#cadastro .mauticform_wrapper form[data-mautic-form]');
    if (!form) return false;
    attachBubbleSubmission(form, produto);
    return true;
  };
  if (attach()) return;
  const observer = new MutationObserver(() => {
    if (attach()) observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  window.setTimeout(() => observer.disconnect(), 20000);
}

