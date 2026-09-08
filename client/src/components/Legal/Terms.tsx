import LegalLayout, { Section, P, List, Placeholder } from './Layout';

/**
 * The commercial clauses describe the billing model as it is actually
 * implemented, not as the pricing page eventually will be:
 *   - Plans are granted by us, not bought. There is no self-serve checkout and
 *     no payment processor, so this document must not describe one.
 *   - A plan's monthly credit allowance is *overwritten* at renewal rather than
 *     added to, so it does not roll over. Purchased credits sit in a separate
 *     bucket and do not expire. Spending draws the expiring allowance first.
 *   - Anonymous visitors get three messages, counted for the lifetime of that
 *     temporary account.
 * Anything here that stops matching `packages/api/src/billing/` is a defect in
 * this page, not a matter of wording.
 */
export default function Terms() {
  return (
    <LegalLayout title="Terms of Service" updated="2026-09-08" incomplete>
      <Section heading="1. These terms">
        <P>
          These terms are an agreement between you and <Placeholder>[LEGAL_ENTITY]</Placeholder>{' '}
          (&quot;we&quot;, &quot;us&quot;), the operator of ChatChat at aichatchat.ai. By using the
          service you accept them. If you do not, do not use the service.
        </P>
        <P>
          Our{' '}
          <a href="/privacy" className="underline">
            Privacy Policy
          </a>{' '}
          explains what we do with your information and forms part of this agreement.
        </P>
      </Section>

      <Section heading="2. Who may use it">
        <P>
          You must be at least 16 years old. If you are using ChatChat for an organisation, you
          confirm you are allowed to accept these terms on its behalf.
        </P>
      </Section>

      <Section heading="3. Your account">
        <P>
          You sign in with Google. Keep that account secure — anything done through your ChatChat
          session is your responsibility. Tell us promptly if you think someone else has access.
        </P>
        <P>
          You can try ChatChat without signing in. That trial is limited to three messages and the
          temporary account behind it is removed after seven days.
        </P>
      </Section>

      <Section heading="4. Plans and credits">
        <P>
          Your plan comes with a monthly allowance of credits. Sending a message spends credits at a
          rate that depends on the model you choose and the length of the exchange; more capable
          models cost more per message.
        </P>
        <List>
          <li>
            <strong>The monthly allowance does not roll over.</strong> On each renewal it is reset
            to your plan&apos;s amount, whether or not you used it.
          </li>
          <li>
            <strong>Credits bought separately do not expire</strong> and are kept apart from the
            monthly allowance. When you send a message, the expiring allowance is used first, so the
            credits you paid for are not wasted.
          </li>
          <li>
            Credits have no cash value, cannot be exchanged for money, and cannot be transferred
            between accounts.
          </li>
          <li>
            When your balance runs out, or is too small to cover the message you are sending, we
            decline the request until the allowance renews or you obtain more credits.
          </li>
        </List>
        <P>
          <strong>During the current phase there is no self-serve purchasing.</strong> Plans are
          granted by us directly and no payment is taken through this site. When we introduce paid
          subscriptions we will publish the prices, the billing terms and a refund and cancellation
          policy before charging anyone.
        </P>
      </Section>

      <Section heading="5. Acceptable use">
        <P>You agree not to use ChatChat to:</P>
        <List>
          <li>break the law, or help anyone else do so;</li>
          <li>
            create or distribute material that sexually exploits children, incites violence, or
            harasses or threatens a specific person;
          </li>
          <li>generate malware, carry out attacks against computer systems, or develop weapons;</li>
          <li>
            impersonate a real person, or present model output as human-written where doing so would
            mislead someone to their detriment;
          </li>
          <li>
            produce bulk spam, or automated content intended to manipulate a public conversation;
          </li>
          <li>
            resell access, share a single account across many people, or use automated means to
            extract credits or capacity beyond what your plan provides;
          </li>
          <li>
            reverse-engineer the service or attempt to reach parts of it you are not authorised to
            reach.
          </li>
        </List>
        <P>
          The models we offer come with their providers&apos; own usage policies, which apply to you
          as well. Where those policies are stricter than this section, the stricter rule governs.
        </P>
      </Section>

      <Section heading="6. Your content">
        <P>
          What you send remains yours. As between you and us, you also own the output the model
          returns to you, to the extent it can be owned at all.
        </P>
        <P>
          You give us permission to store, transmit and process your content only as far as it takes
          to run the service — including sending it to the model provider you selected. We claim no
          other rights over it, and we do not use it to train models.
        </P>
        <P>
          You are responsible for what you send, and for making sure you have the right to send it.
        </P>
      </Section>

      <Section heading="7. What the models produce">
        <P>
          <strong>
            Model output can be wrong, and it is often wrong in a confident and plausible way.
          </strong>{' '}
          Check anything you intend to rely on. ChatChat is not a substitute for professional advice
          — medical, legal, financial or otherwise — and you should not treat it as one.
        </P>
        <P>
          Different users can receive similar or identical output for similar prompts, and output is
          not guaranteed to be unique or free of third-party rights.
        </P>
      </Section>

      <Section heading="8. Availability">
        <P>
          We aim to keep ChatChat running, but we do not promise it will be uninterrupted or
          error-free. We depend on model providers whose availability we do not control, and we may
          change, suspend or withdraw models and features. Where a change materially reduces what
          your plan offers, we will tell you.
        </P>
      </Section>

      <Section heading="9. Ending the agreement">
        <P>
          You can stop using ChatChat and delete your account at any time from your settings.
          Deletion removes your conversations, files and records, and cannot be undone.
        </P>
        <P>
          We may suspend or close your account if you breach these terms, if we are required to by
          law, or if keeping it open would expose us or other users to serious risk. Where the
          circumstances allow, we will warn you first.
        </P>
      </Section>

      <Section heading="10. Disclaimers and liability">
        <P>
          The service is provided &quot;as is&quot;, without warranties of any kind, to the fullest
          extent the law allows.
        </P>
        <P>
          We are not liable for indirect or consequential losses, lost profits, or lost data. Our
          total liability to you for any claim is limited to the amount you paid us in the twelve
          months before it arose, or <Placeholder>[LIABILITY_FLOOR]</Placeholder> if that is
          greater.
        </P>
        <P>
          Nothing here excludes liability that cannot lawfully be excluded, and if you are a
          consumer you keep the statutory rights your local law gives you.
        </P>
      </Section>

      <Section heading="11. Changes to these terms">
        <P>
          We may update these terms. The date at the top shows when they last changed. For material
          changes we will give notice in the app before they take effect; continuing to use ChatChat
          afterwards means you accept them.
        </P>
      </Section>

      <Section heading="12. Governing law">
        <P>
          These terms are governed by the laws of <Placeholder>[JURISDICTION]</Placeholder>, and the
          courts of <Placeholder>[JURISDICTION]</Placeholder> have exclusive jurisdiction — except
          that if you are a consumer, you may also bring proceedings where you live, under the law
          that protects you there.
        </P>
      </Section>

      <Section heading="13. Contact">
        <P>
          Questions about these terms go to <Placeholder>[LEGAL_CONTACT_EMAIL]</Placeholder>.
        </P>
      </Section>
    </LegalLayout>
  );
}
