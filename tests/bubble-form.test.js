import test from 'node:test';
import assert from 'node:assert/strict';
import { BUBBLE_ENDPOINT, PRODUCT, createBubblePayload, attachBubbleSubmission } from '../src/scripts/bubble-form.js';

function fixture({ request, valid = true, sdkValid = true } = {}) {
  const inputs = Object.fromEntries(Object.entries({
    nome_completo1: ' Ana ', sobrenome: ' Souza Lima ', email: ' ana@example.com ', telefone: '(11) 98765-4321',
  }).map(([key, value]) => [`mauticform[${key}]`, { value, readOnly: false }]));
  const button = { disabled: false, innerHTML: 'Liberar Acesso', textContent: '' };
  const error = { textContent: '', setAttribute() {} };
  let submit;
  const form = {
    dataset: {},
    elements: { namedItem: (name) => inputs[name] },
    getAttribute: () => 'isca',
    querySelector: (selector) => selector.includes('button') ? button : error,
    reportValidity: () => valid,
    addEventListener: (_event, handler) => { submit = handler; },
  };
  const calls = [];
  const callbacks = {};
  const sdk = { validateForm: (_name, send) => { calls.push(send); return sdkValid; } };
  const requests = [];
  attachBubbleSubmission(form, {
    sdk, callbacks,
    request: async (...args) => {
      requests.push(args);
      return request ? request(...args) : { ok: true, text: async () => '{"status":"success","response":{}}' };
    },
  });
  return {
    form, inputs, button, error, calls, callbacks, requests,
    submit: () => submit({ preventDefault() {}, stopImmediatePropagation() {} }),
  };
}

test('payload sends name, full surname, email and phone without product', () => {
  const f = fixture();
  assert.deepEqual(createBubblePayload(f.form), {
    nome: 'Ana', email: 'ana@example.com', celular: '11987654321', sobrenome: 'Souza Lima',
  });
});

test('POST JSON to Bubble before handing off to Mautic', async () => {
  const f = fixture();
  await f.submit();
  const [url, options] = f.requests[0];
  assert.equal(BUBBLE_ENDPOINT, 'https://flashmedradarquestoes.bubbleapps.io/api/1.1/wf/sign_up_temas_mais_caem');
  assert.equal(url, BUBBLE_ENDPOINT);
  assert.equal(options.method, 'POST');
  assert.equal(options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(options.body), createBubblePayload(f.form));
  assert.deepEqual(f.calls, [false, true]);
});

test('invalid native or Mautic validation does not send to Bubble', async () => {
  for (const option of [{ valid: false }, { sdkValid: false }]) {
    const f = fixture(option);
    await f.submit();
    assert.equal(f.requests.length, 0);
    assert.ok(!f.calls.includes(true));
  }
});

test('invalid phone does not send', async () => {
  const f = fixture();
  f.inputs['mauticform[telefone]'].value = '123';
  await f.submit();
  assert.equal(f.requests.length, 0);
  assert.match(f.error.textContent, /DDD/);
});

test('Bubble failure shows an error, restores controls and allows retry', async () => {
  let fail = true;
  const f = fixture({ request: async () => fail
    ? { ok: false, status: 401 }
    : { ok: true, text: async () => '{"status":"success"}' } });
  const originalError = console.error;
  console.error = () => {};
  try {
    await f.submit();
    assert.deepEqual(f.calls, [false]);
    assert.equal(f.button.disabled, false);
    assert.match(f.error.textContent, /Não foi possível/);
    assert.ok(Object.values(f.inputs).every((input) => !input.readOnly));
    fail = false;
    await f.submit();
    assert.equal(f.requests.length, 2);
    assert.ok(f.calls.includes(true));
  } finally { console.error = originalError; }
});

test('repeated submit while waiting produces only one Bubble request', async () => {
  let release;
  const f = fixture({ request: () => new Promise((resolve) => { release = resolve; }) });
  const first = f.submit();
  await f.submit();
  assert.equal(f.requests.length, 1);
  assert.equal(f.button.disabled, true);
  assert.deepEqual(f.calls, [false]);
  release({ ok: true, text: async () => '{"status":"success"}' });
  await first;
  assert.deepEqual(f.calls, [false, true]);
});

test('retry after a Mautic response error does not duplicate confirmed Bubble data', async () => {
  const f = fixture();
  await f.submit();
  f.callbacks.isca.onResponseEnd({ errorMessage: 'Erro no Mautic' });
  await f.submit();
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.calls, [false, true, false, true]);
});

test('successful redirect preserves destination, query and fragment and encodes the submitted email', async () => {
  const f = fixture();
  f.inputs['mauticform[email]'].value = ' ana+isca@example.com ';
  await f.submit();
  f.inputs['mauticform[email]'].value = '';
  const response = { success: true, redirect: 'https://spp.vemmed.com/produto?origem=isca&email=antigo#conteudo' };
  f.callbacks.isca.onResponseStart(response);
  assert.equal(response.redirect, 'https://spp.vemmed.com/produto?origem=isca&email=ana%2Bisca%40example.com&produto=tema#conteudo');
  assert.equal(new URL(response.redirect).searchParams.getAll('email').length, 1);
  assert.equal(new URL(response.redirect).searchParams.get('produto'), PRODUCT);
});

test('relative redirects resolve against the page address', async () => {
  const f = fixture();
  f.form.ownerDocument = { baseURI: 'https://captura.example.com/cadastro/' };
  await f.submit();
  const response = { success: true, redirect: '/obrigado?produto=isca' };
  f.callbacks.isca.onResponseStart(response);
  assert.equal(response.redirect, 'https://captura.example.com/obrigado?produto=tema&email=ana%40example.com');
});

test('failed or unconfirmed Mautic responses keep the original redirect unchanged', async () => {
  const f = fixture();
  await f.submit();
  for (const fields of [
    { success: false },
    { success: 0 },
    { success: true, errorMessage: 'Erro' },
    { success: true, validationErrors: { email: 'Inválido' } },
    {},
  ]) {
    const response = { ...fields, redirect: 'https://spp.vemmed.com/produto' };
    f.callbacks.isca.onResponseStart(response);
    assert.equal(response.redirect, 'https://spp.vemmed.com/produto');
  }
});

test('no redirect is invented when Mautic has no destination configured', async () => {
  const f = fixture();
  await f.submit();
  const response = { success: true };
  f.callbacks.isca.onResponseStart(response);
  assert.equal(response.redirect, undefined);
});

test('email is not added without confirmed Bubble delivery', () => {
  const f = fixture();
  const response = { success: true, redirect: 'https://spp.vemmed.com/produto' };
  f.callbacks.isca.onResponseStart(response);
  assert.equal(response.redirect, 'https://spp.vemmed.com/produto');
});


test('Mautic numeric success adds email and product to the thank-you URL', async () => {
  const f = fixture();
  await f.submit();
  const response = { success: 1, redirect: 'https://example.com/obrigado' };
  f.callbacks.isca.onResponseStart(response);
  assert.equal(response.redirect, 'https://example.com/obrigado?email=ana%40example.com&produto=tema');
});
