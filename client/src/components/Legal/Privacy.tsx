import LegalLayout, { Section, P, List, Placeholder } from './Layout';

/**
 * Every factual claim here was checked against the running system rather than
 * against the design docs, because a privacy policy that describes an intention
 * is worse than none: it is a promise the product does not keep.
 *
 * Checked on 2026-09-08 against production:
 *   - Google OAuth is the only signup route (`ALLOW_REGISTRATION=false`,
 *     `ALLOW_SOCIAL_LOGIN=true`); there is no email/password registration and no
 *     email service configured at all.
 *   - Anonymous visitors get a real account with a 7-day TTL on the `User` row.
 *   - Files go to Cloudflare R2; everything else to MongoDB Atlas; the app runs
 *     in the United States.
 *   - No retention limit is configured for conversations. They persist until
 *     deleted. Saying anything else would be false.
 *   - `deleteUserController` removes conversations, messages, files, balance,
 *     transactions and billing records.
 *   - No tag manager or advertising tracker is configured. Error reporting
 *     (Sentry) and product analytics (PostHog) are wired in and send only an
 *     irreversible hash of the user id plus a fixed allowlist of properties —
 *     never message content. Both are inert until their keys are set.
 *   - **We pass no training opt-out or zero-retention flag to any provider.**
 *     `zdrEnabled` exists in the SDK's option list and is never set. The
 *     "vendor training disabled by default" line in the stage-4 spec is not
 *     implemented, so this page must not imply that it is.
 */
export default function Privacy() {
  return (
    <LegalLayout title="Privacy Policy" updated="2026-09-08" incomplete>
      <Section heading="1. Who we are">
        <P>
          ChatChat is an AI workspace that lets you use several large language models through one
          interface, available at aichatchat.ai. This policy explains what we collect, why, and what
          you can do about it.
        </P>
        <P>
          The service is operated by <Placeholder>[LEGAL_ENTITY]</Placeholder>, registered in{' '}
          <Placeholder>[JURISDICTION]</Placeholder>. You can reach us about anything in this policy
          at <Placeholder>[PRIVACY_CONTACT_EMAIL]</Placeholder>.
        </P>
      </Section>

      <Section heading="2. What we collect">
        <P>
          <strong>Account information.</strong> You sign in with Google, and we receive the email
          address, name and profile picture on that Google account. We never receive your Google
          password. We do not currently offer email-and-password accounts.
        </P>
        <P>
          <strong>If you use ChatChat without signing in.</strong> We create a temporary account for
          you behind the scenes so the trial works, identified only by a randomly generated
          reference. It holds no personal details, and it is deleted automatically after seven days
          unless you sign in and claim it.
        </P>
        <P>
          <strong>What you send and receive.</strong> Your messages, the model&apos;s replies, and
          any files you upload. This is the substance of the service — we store it so your
          conversations are still there when you come back.
        </P>
        <P>
          <strong>Usage records.</strong> For each response, we record which model produced it, how
          many tokens it consumed and what that cost. We use this to meter your plan allowance and
          to understand our own costs. It does not include the content of the message.
        </P>
        <P>
          <strong>Technical data.</strong> Ordinary server logs, and a session cookie that keeps you
          signed in. We run no advertising and no third-party ad tracking, and nothing on this site
          follows you across other websites.
        </P>
        <P>
          <strong>Diagnostics and product measurement.</strong> When something breaks, an error
          report goes to our error-tracking provider. Separately, we record a small set of product
          events — that a message was sent, which model and plan it used, that a signup completed,
          that an allowance ran out.{' '}
          <strong>
            Neither includes the content of your conversations, your files, your name or your email.
          </strong>{' '}
          In both, you appear as an irreversible hash of your account identifier rather than as an
          account we could look you up by.
        </P>
      </Section>

      <Section heading="3. Why we use it">
        <List>
          <li>
            To provide the service — sending your messages to models and returning the replies.
          </li>
          <li>To keep your conversation history available to you.</li>
          <li>To apply your plan&apos;s allowance and prevent abuse of the free trial.</li>
          <li>To keep the service secure and to diagnose faults.</li>
          <li>To comply with the law where we are required to.</li>
        </List>
        <P>
          We do not sell your personal information, and we do not use your conversations to train
          any model of our own.
        </P>
      </Section>

      <Section heading="4. Who else sees it">
        <P>
          To generate a reply, the content of your conversation is sent to the provider of the model
          you selected, and to the API infrastructure providers through which we reach them. The
          providers whose models we offer are Anthropic, OpenAI, Google, xAI, DeepSeek, Zhipu,
          Moonshot and MiniMax. Which one receives your message depends entirely on the model you
          pick.
        </P>
        <P>
          <strong>What those providers do with it is governed by their own terms, not ours.</strong>{' '}
          We want to be exact here rather than reassuring: we do not currently send provider-side
          &quot;do not train&quot; or zero-retention instructions with your requests. If that
          matters to you, treat what you send as visible to the model provider under their published
          policy. We intend to enable those settings where providers support them, and this page
          will change when we do.
        </P>
        <P>We also rely on these companies to run the service:</P>
        <List>
          <li>
            <strong>MongoDB Atlas</strong> — stores accounts, conversations and messages.
          </li>
          <li>
            <strong>Cloudflare</strong> — stores uploaded files, and fronts the site.
          </li>
          <li>
            <strong>Hostinger</strong> — hosts the application servers.
          </li>
          <li>
            <strong>Google</strong> — handles sign-in.
          </li>
          <li>
            <strong>Sentry</strong> — receives error reports so we can find faults without waiting
            for someone to tell us.
          </li>
          <li>
            <strong>PostHog</strong> — receives the product events above. Hosted in the European
            Union.
          </li>
        </List>
        <P>
          Beyond that, we disclose personal information only if the law requires it, or to protect
          the rights and safety of our users or ourselves.
        </P>
      </Section>

      <Section heading="5. Where your data is held">
        <P>
          Our servers and databases are located in the United States. Model providers and
          infrastructure providers may process your requests elsewhere. If you are in the European
          Economic Area or the United Kingdom, this means your information is transferred outside
          it.
        </P>
      </Section>

      <Section heading="6. How long we keep it">
        <P>
          <strong>Conversations, messages and files are kept until you delete them.</strong> We do
          not currently apply an automatic expiry to them. If you want something gone, delete the
          conversation or the file, or delete your account.
        </P>
        <P>
          Temporary accounts created for visitors who have not signed in are deleted automatically
          seven days after they are created.
        </P>
        <P>
          When you delete your account, we remove your conversations, messages, uploaded files,
          balance, usage records and plan records. Deletion is immediate and we cannot undo it.
          Copies already sent to a model provider are outside our control and subject to that
          provider&apos;s own retention.
        </P>
      </Section>

      <Section heading="7. Your rights">
        <P>
          Depending on where you live, you may have the right to access the personal information we
          hold about you, correct it, delete it, obtain a copy of it, object to how we use it, or
          complain to your local data protection authority. These rights are given by the GDPR in
          the EEA and the UK, and by comparable laws elsewhere.
        </P>
        <P>
          You can exercise the most important of them yourself: your conversations are visible and
          deletable in the app, and account deletion is in your settings. For anything else, write
          to <Placeholder>[PRIVACY_CONTACT_EMAIL]</Placeholder> and we will respond within 30 days.
        </P>
      </Section>

      <Section heading="8. Children">
        <P>
          ChatChat is not intended for anyone under 16, and we do not knowingly collect information
          from them. If you believe a child has given us personal information, contact us and we
          will delete it.
        </P>
      </Section>

      <Section heading="9. Security">
        <P>
          We use encrypted connections, store credentials only in hashed or provider-held form, and
          restrict access to production data. No service can promise perfect security, and we do
          not.
        </P>
      </Section>

      <Section heading="10. Changes">
        <P>
          We will update this page when the product changes, and the date at the top will tell you
          when. If a change materially affects your rights, we will make it visible in the app
          rather than relying on you to re-read this page.
        </P>
      </Section>
    </LegalLayout>
  );
}
