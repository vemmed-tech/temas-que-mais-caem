import test from 'node:test';
import assert from 'node:assert/strict';
import { BUBBLE_ENDPOINT, createBubblePayload, attachBubbleSubmission } from '../src/scripts/bubble-form.js';

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

test('Mautic redirects to SPP with the confirmed email only after both submissions succeed', async () => {
  const f = fixture();
  f.inputs['mauticform[email]'].value = ' ana+temas@example.com ';
  await f.submit();
  const response = { success: true, redirect: 'https://example.com/old-destination' };
  f.callbacks.isca.onResponseStart(response);
  assert.equal(response.redirect, 'https://spp.vemmed.com/temas_mais_caem?email=ana%2Btemas%40example.com');
  assert.equal(new URL(response.redirect).searchParams.get('email'), 'ana+temas@example.com');
});

test('redirect uses submitted email even if Mautic clears the form', async () => {
  const f = fixture();
  await f.submit();
  f.inputs['mauticform[email]'].value = '';
  const response = { success: true };
  f.callbacks.isca.onResponseStart(response);
  assert.equal(new URL(response.redirect).searchParams.get('email'), 'ana@example.com');
});

test('Mautic failure or unconfirmed response does not add a redirect', async () => {
  const f = fixture();
  await f.submit();
  for (const response of [
    { success: false, errorMessage: 'Erro no Mautic' },
    { success: true, errorMessage: 'Erro no Mautic' },
    { success: true, validationErrors: { email: 'Email inválido' } },
    {},
  ]) {
    f.callbacks.isca.onResponseStart(response);
    assert.equal(response.redirect, undefined);
  }
});

test('no SPP redirect is added without confirmed Bubble delivery', () => {
  const f = fixture();
  const response = { success: true };
  f.callbacks.isca.onResponseStart(response);
  assert.equal(response.redirect, undefined);
});

