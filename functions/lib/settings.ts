import Razorpay from './razorpay';

/** The Razorpay client with the merchant's keys from the app's card settings */
export async function getRazorpay(req: SwellRequest): Promise<Razorpay> {
  const settings = await req.swell.settings(`${req.appId}/card`);
  return new Razorpay(settings?.key_id, settings?.key_secret);
}
