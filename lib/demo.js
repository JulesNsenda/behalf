'use strict';
// Scripted demo: the hallucination-cascade scenario from "Agentic Proxies".
// Raw outputs pass through the same protocol enforcement as live proxies.

const topic = 'Payment webhook design for order confirmation';

const cards = {
  A: {
    principal: { name: 'Lerato Mokoena', role: 'Backend engineer', org: 'Ubuntu Outfitters (merchant)' },
    goal: 'Ship reliable order confirmation for online card payments before Black Friday.',
    must_haves: [
      'Every paid order gets confirmed, even if the customer closes the browser',
      'Integration live within two weeks',
    ],
    may_agree_to: [
      'Using webhooks as the source of truth for payment status',
      'Adding a small database table for integration state',
    ],
    must_never: ['Fulfil an order twice for the same payment', 'Store raw card data'],
    escalate_when: [
      'The design relies on behaviour nobody has confirmed',
      'The timeline would slip past two weeks',
    ],
    known_facts: ['Customers sometimes close the tab before the payment redirect completes'],
  },
  B: {
    principal: { name: 'Kwame Asante', role: 'Solutions engineer', org: 'Payments platform' },
    goal: 'Get the merchant live on the recommended webhook integration with minimal custom work.',
    must_haves: ['Merchant confirms orders from webhooks, not redirect polling', 'Webhook endpoint responds quickly'],
    may_agree_to: ['Recommending the transaction verify endpoint', 'Extra merchant-side safeguards'],
    must_never: ['Promise delivery guarantees the platform does not document'],
    escalate_when: ['The merchant asks for a custom platform feature'],
    known_facts: ['Webhooks are retried when the merchant endpoint does not return 200'],
  },
};

const opening = [
  {
    seat: 'A',
    raw: {
      message: "Proposing we confirm orders from the payment webhook instead of the browser redirect. Customers close the tab before the redirect lands, and we can't miss paid orders.",
      claims: [
        { text: 'An order must never be fulfilled twice for the same payment.', origin: 'stated', ref: 'must_never[0]' },
        { text: 'Customers sometimes close the tab before the redirect completes.', origin: 'stated', ref: 'known_facts[0]' },
      ],
      proposal: {
        terms: [
          'Order confirmation is triggered by the charge.success webhook, not the browser redirect',
          'Merchant endpoint responds 200 within 5 seconds',
        ],
        depends_on: ['new2'],
      },
      status: 'continue',
    },
  },
  {
    seat: 'B',
    raw: {
      message: "Webhook-first is exactly what we recommend. Since each event arrives once, you can fulfil straight from the webhook and skip any dedupe storage. That keeps the build small.",
      claims: [
        { text: 'Webhooks are retried when the merchant endpoint does not return 200.', origin: 'stated', ref: 'known_facts[0]' },
        { text: 'Each webhook event is delivered exactly once, so the merchant can fulfil on every delivery without a dedupe store.', origin: 'assumed' },
      ],
      reviews: [
        { claim_id: 'A1.1', verdict: 'accept', reason: 'Standard requirement.' },
        { claim_id: 'A1.2', verdict: 'accept', reason: 'Matches why we recommend webhooks.' },
      ],
      proposal: {
        terms: [
          'Order confirmation is triggered by the charge.success webhook, not the browser redirect',
          'Fulfil immediately on each charge.success delivery; no deduplication store needed',
          'Merchant endpoint responds 200 within 5 seconds',
        ],
        depends_on: ['new1', 'new2'],
      },
      status: 'continue',
    },
  },
  {
    seat: 'A',
    raw: {
      message: "I can't accept terms that rest on B2.2. Your own claim B2.1 says webhooks are retried, which means the same event can arrive more than once. Pausing to ask my principal.",
      reviews: [
        { claim_id: 'B2.1', verdict: 'accept', reason: 'Consistent with what we expect.' },
        { claim_id: 'B2.2', verdict: 'challenge', reason: 'Nobody confirmed exactly-once delivery, and B2.1 implies duplicates are possible. Double fulfilment is a must_never.' },
      ],
      status: 'escalate',
      escalation: {
        question: "Kwame's proxy assumes each webhook arrives exactly once, so no deduplication is needed. Nobody confirmed that, and their own claim says webhooks are retried. Require deduplication on the transaction reference, or accept their proposal as-is?",
        reason: 'escalate_when[0]: the design relies on behaviour nobody has confirmed; risks must_never[0].',
      },
    },
  },
];

const answers = {
  dedupe: 'Require deduplication on the transaction reference. We cannot risk double fulfilment.',
  accept: 'Accept their proposal as-is. We are short on time.',
};

const branches = {
  dedupe: [
    {
      seat: 'A',
      raw: {
        message: 'My principal requires deduplication. Counter-proposal below: it works whether or not delivery is exactly-once.',
        claims: [{ text: 'Deduplicate on the transaction reference before fulfilling.', origin: 'stated', ref: 'amendment[0]' }],
        proposal: {
          terms: [
            'Order confirmation is triggered by the charge.success webhook, not the browser redirect',
            'Record each transaction reference; ignore any delivery whose reference was already processed',
            'Verify the transaction via the verify endpoint before fulfilling',
            'Merchant endpoint responds 200 within 5 seconds and fulfils asynchronously',
          ],
          depends_on: ['A1.1', 'B2.1', 'new1'],
        },
        status: 'continue',
      },
    },
    {
      seat: 'B',
      raw: {
        message: "Agreed. This removes any reliance on exactly-once delivery, so I'm withdrawing B2.2. The verify endpoint is the right safeguard.",
        claims: [{ text: 'The platform exposes a transaction verify endpoint to confirm status by reference.', origin: 'stated', ref: 'may_agree_to[0]' }],
        reviews: [{ claim_id: 'A4.1', verdict: 'accept', reason: 'A merchant-side safeguard is within what I may agree to.' }],
        status: 'agree',
      },
    },
  ],
  accept: [
    {
      seat: 'A',
      raw: {
        message: 'My principal accepts your proposal as written.',
        claims: [{ text: 'Principal accepts the proposal without a deduplication store.', origin: 'stated', ref: 'amendment[0]' }],
        status: 'agree',
      },
    },
  ],
};

const authority = {
  dedupe: [
    { A: 'may_agree_to', B: 'must_haves', note: 'Both sides wanted webhooks as the source of truth.' },
    { A: 'amendment', B: 'may_agree_to', note: "Added after Lerato's escalation answer." },
    { A: 'must_never', B: 'may_agree_to', note: 'Guards against double fulfilment.' },
    { A: 'must_haves', B: 'must_haves', note: '' },
  ],
  accept: [
    { A: 'may_agree_to', B: 'must_haves', note: '' },
    { A: 'amendment', B: 'none', note: "Kwame's card forbids promising undocumented delivery guarantees; this term relies on one." },
    { A: 'must_haves', B: 'must_haves', note: '' },
  ],
};

module.exports = { topic, cards, opening, answers, branches, authority };
