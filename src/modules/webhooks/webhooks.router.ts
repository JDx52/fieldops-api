import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { query } from '../../config/db';
import { logger } from '../../utils/logger';

export const webhooksRouter = Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '', { apiVersion: '2023-10-16' });

// Raw body needed for Stripe signature verification
// Mount BEFORE express.json() in main app
webhooksRouter.post('/stripe', async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'];
  if (!sig) return res.status(400).send('Missing stripe-signature header');

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body, // raw buffer
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err: any) {
    logger.error('Stripe webhook signature verification failed', err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'payment_intent.succeeded': {
        const intent = event.data.object as Stripe.PaymentIntent;
        const invoiceId = intent.metadata?.invoice_id;
        if (invoiceId) {
          await query(
            `UPDATE payments SET status='succeeded', paid_at=NOW() WHERE stripe_payment_id=$1`,
            [intent.id]
          );
          logger.info('Payment succeeded', { intent_id: intent.id, invoice_id: invoiceId });
        }
        break;
      }

      case 'payment_intent.payment_failed': {
        const intent = event.data.object as Stripe.PaymentIntent;
        await query(
          `UPDATE payments SET status='failed' WHERE stripe_payment_id=$1`,
          [intent.id]
        );
        logger.warn('Payment failed', { intent_id: intent.id });
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        await query(
          `UPDATE service_agreements SET status='cancelled', updated_at=NOW() WHERE stripe_subscription_id=$1`,
          [sub.id]
        );
        break;
      }

      case 'invoice.paid': {
        const stripeInvoice = event.data.object as Stripe.Invoice;
        logger.info('Stripe invoice paid', { stripe_invoice_id: stripeInvoice.id });
        break;
      }

      default:
        logger.debug('Unhandled Stripe event', { type: event.type });
    }
  } catch (err) {
    logger.error('Error processing Stripe webhook', err);
    return res.status(500).send('Webhook processing error');
  }

  res.json({ received: true });
});
