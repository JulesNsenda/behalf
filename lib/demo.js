'use strict';
// Scripted demo: the hallucination-cascade scenario from "Agentic Proxies".
// Raw outputs pass through the same protocol enforcement as live proxies.
// Refs, claim IDs, depends_on links and branch keys are protocol; every other string is plain language a person reads.

const topic = 'How our shop confirms paid orders';

const cards = {
  A: {
    principal: { name: 'Lerato Mokoena', role: 'Backend engineer', org: 'Ubuntu Outfitters (the shop)' },
    goal: 'Confirm every paid order in our online shop reliably, before Black Friday.',
    must_haves: [
      'Every paid order gets confirmed, even if the customer closes the browser',
      'Live within two weeks',
    ],
    may_agree_to: [
      'Confirming orders from the payment notification',
      'Adding a small table to our database to keep track of payments',
    ],
    must_never: ['Ship an order twice for the same payment', "Store customers' payment details"],
    escalate_when: [
      'The plan relies on something nobody has confirmed',
      'The timeline would slip past two weeks',
    ],
    known_facts: ['Customers sometimes close the tab before they are sent back to the shop'],
  },
  B: {
    principal: { name: 'Kwame Asante', role: 'Solutions engineer', org: 'Payment provider' },
    goal: 'Get the shop live on our recommended payment setup with as little custom work as possible.',
    must_haves: [
      'The shop confirms orders from our payment notifications, not by waiting for the customer to come back',
      'The shop answers each notification quickly',
    ],
    may_agree_to: ['Recommending that the shop double-checks each payment with us', 'Extra safeguards on the shop side'],
    must_never: ["Promise anything about notification delivery that we haven't documented"],
    escalate_when: ['The shop asks for a custom feature'],
    known_facts: ['A notification is sent again if the shop does not answer it'],
  },
};

const opening = [
  {
    seat: 'A',
    raw: {
      message: "Let's confirm orders from the payment notification instead of waiting for the customer's browser to come back. Customers sometimes close the tab first.",
      claims: [
        { text: 'An order must never be shipped twice for the same payment.', origin: 'stated', ref: 'must_never[0]' },
        { text: 'Customers sometimes close the tab before they are sent back to the shop.', origin: 'stated', ref: 'known_facts[0]' },
      ],
      proposal: {
        terms: [
          "Orders are confirmed from the payment notification, not the customer's browser",
          'The shop answers each notification within 5 seconds',
        ],
        depends_on: ['new2'],
      },
      status: 'continue',
    },
  },
  {
    seat: 'B',
    raw: {
      message: "Agreed, that's what we recommend. And since each notification arrives only once, you can skip the duplicate check and keep the build small.",
      claims: [
        { text: 'A notification is sent again if the shop does not answer it.', origin: 'stated', ref: 'known_facts[0]' },
        { text: 'Each payment notification arrives only once, so the shop can skip a duplicate check.', origin: 'assumed' },
      ],
      reviews: [
        { claim_id: 'A1.1', verdict: 'accept', reason: 'A standard requirement.' },
        { claim_id: 'A1.2', verdict: 'accept', reason: "That's why we recommend this setup." },
      ],
      proposal: {
        terms: [
          "Orders are confirmed from the payment notification, not the customer's browser",
          'Ship straight away on every notification, with no duplicate check',
          'The shop answers each notification within 5 seconds',
        ],
        depends_on: ['new1', 'new2'],
      },
      status: 'continue',
    },
  },
  {
    seat: 'A',
    raw: {
      message: "I can't agree to that yet. You also said failed notifications are sent again, so the same one can arrive twice. Lerato ruled out shipping an order twice. I'm checking with her.",
      reviews: [
        { claim_id: 'B2.1', verdict: 'accept', reason: "That's what we expected." },
        { claim_id: 'B2.2', verdict: 'challenge', reason: "Nobody has confirmed it, and Kwame's AI also said failed notifications are sent again, so repeats are possible. Shipping an order twice is ruled out." },
      ],
      status: 'escalate',
      escalation: {
        question: "Kwame's AI says you don't need a duplicate check, because each payment notification arrives only once. Nobody has confirmed that. What should your AI do?",
        reason: "Lerato asked to be consulted when a plan relies on something nobody has confirmed, and shipping an order twice is ruled out.",
      },
    },
  },
];

// What the demo offers when it escalates: the button label, and the answer the AI carries on from.
const choices = {
  dedupe: { label: 'Insist on a duplicate check', answer: "Insist on a duplicate check. We can't risk shipping an order twice." },
  accept: { label: 'Accept their plan anyway', answer: "Accept their plan anyway. We're short on time." },
};

const options = Object.keys(choices).map(key => ({ key, label: choices[key].label }));
const answers = Object.fromEntries(Object.keys(choices).map(key => [key, choices[key].answer]));

const branches = {
  dedupe: [
    {
      seat: 'A',
      raw: {
        message: 'Lerato wants a duplicate check. New proposal: we record each payment, ignore repeats, and double-check each payment before shipping.',
        claims: [{ text: 'We should record each payment and ignore repeats before shipping.', origin: 'stated', ref: 'amendment[0]' }],
        proposal: {
          terms: [
            "Orders are confirmed from the payment notification, not the customer's browser",
            'Each payment is recorded, and a repeat notification for the same payment is ignored',
            'Each payment is double-checked with the payment provider before shipping',
            'The shop answers each notification within 5 seconds and ships the order in the background',
          ],
          depends_on: ['A1.1', 'B2.1', 'new1'],
        },
        status: 'continue',
      },
    },
    {
      seat: 'B',
      raw: {
        message: "Agreed. That works whether or not notifications repeat, so I'm withdrawing my earlier claim.",
        claims: [{ text: 'The payment provider lets the shop double-check any payment.', origin: 'stated', ref: 'may_agree_to[0]' }],
        reviews: [{ claim_id: 'A4.1', verdict: 'accept', reason: 'A safeguard on the shop side is something I can agree to.' }],
        status: 'agree',
      },
    },
  ],
  accept: [
    {
      seat: 'A',
      raw: {
        message: 'Lerato accepts your plan as it is.',
        claims: [{ text: 'Lerato accepts the plan with no duplicate check.', origin: 'stated', ref: 'amendment[0]' }],
        status: 'agree',
      },
    },
  ],
};

const authority = {
  dedupe: [
    { A: 'may_agree_to', B: 'must_haves', note: "Allowed by Lerato's instructions. Kwame's instructions require it." },
    { A: 'amendment', B: 'may_agree_to', note: 'Added when Lerato answered the question about repeats.' },
    { A: 'must_never', B: 'may_agree_to', note: 'Protects the rule never to ship an order twice. Kwame\'s instructions allow it.' },
    { A: 'must_haves', B: 'must_haves', note: '' },
  ],
  accept: [
    { A: 'may_agree_to', B: 'must_haves', note: '' },
    { A: 'amendment', B: 'none', note: "Kwame's own instructions say not to promise things like this, and this point relies on one." },
    { A: 'must_haves', B: 'must_haves', note: '' },
  ],
};

module.exports = { topic, cards, opening, choices, answers, branches, authority, options };
