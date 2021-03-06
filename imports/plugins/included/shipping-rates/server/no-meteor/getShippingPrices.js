import Logger from "@reactioncommerce/logger";
import ReactionError from "@reactioncommerce/reaction-error";

/**
 * @summary Returns a list of shipping rates based on the items in a cart.
 * @param {Object} context - Context
 * @param {Object} cart - details about the purchase a user wants to make.
 * @param {Array} [previousQueryResults] - an array of shipping rates and
 * info about failed calls to the APIs of some shipping methods providers
 * e.g Shippo.
 * @return {Array} - an array that contains two arrays: the first array will
 * be an updated list of shipping rates, and the second will contain info for
 * retrying this specific package if any errors occurred while retrieving the
 * shipping rates.
 * @private
 */
export default async function getShippingPrices(context, cart, previousQueryResults = []) {
  const { collections } = context;
  const { Packages, Shipping } = collections;
  const [rates = [], retrialTargets = []] = previousQueryResults;
  const currentMethodInfo = {
    packageName: "flat-rate-shipping",
    fileName: "hooks.js"
  };

  if (retrialTargets.length > 0) {
    const isNotAmongFailedRequests = retrialTargets.every((target) =>
      target.packageName !== currentMethodInfo.packageName &&
      target.fileName !== currentMethodInfo.fileName);
    if (isNotAmongFailedRequests) {
      return previousQueryResults;
    }
  }

  // Verify that we have shipping records
  if (!cart.shipping || !cart.shipping.length) {
    const errorDetails = {
      requestStatus: "error",
      shippingProvider: "flat-rate-shipping",
      message: "this cart is missing shipping records"
    };
    return [[errorDetails], []];
  }

  // Verify that we have a valid address to work with
  let shippingErrorDetails;
  if (cart.shipping.find((shippingRecord) => !shippingRecord.address)) {
    shippingErrorDetails = {
      requestStatus: "error",
      shippingProvider: "flat-rate-shipping",
      message: "The address property on one or more shipping records are incomplete"
    };
    return [[shippingErrorDetails], []];
  }

  // Validate that we have valid items to work with. We should never get here since we filter for this
  // at the cart level
  if (!cart.items || !cart.items.length) {
    const errorDetails = {
      requestStatus: "error",
      shippingProvider: "flat-rate-shipping",
      message: "this cart has no items"
    };
    return [[errorDetails], []];
  }

  let merchantShippingRates = false;
  const marketplaceSettings = await Packages.findOne({
    name: "reaction-marketplace",
    shopId: context.shopId, // the primary shop always owns the marketplace settings
    enabled: true // only use the marketplace settings if marketplace is enabled
  });
  if (marketplaceSettings && marketplaceSettings.settings && marketplaceSettings.settings.enabled) {
    ({ merchantShippingRates } = marketplaceSettings.settings.public);
  }

  if (merchantShippingRates) {
    // TODO this needs to be rewritten to handle getting rates from each shops that's represented on the order
    throw new ReactionError("not-implemented", "Multiple shipping providers is currently not supported");
  }

  const pkgData = await Packages.findOne({
    name: "reaction-shipping-rates",
    shopId: context.shopId
  });

  if (!pkgData || pkgData.settings.flatRates.enabled !== true) {
    return [rates, retrialTargets];
  }

  const itemShopIds = cart.shipping.filter((group) => group.type === "shipping").map((group) => group.shopId);

  const shippingRateDocs = await Shipping.find({
    "shopId": {
      $in: itemShopIds
    },
    "provider.enabled": true
  }).toArray();

  const initialNumOfRates = rates.length;
  shippingRateDocs.forEach((doc) => {
    const carrier = doc.provider.label;
    for (const method of doc.methods) {
      if (!method.enabled) {
        continue;
      }
      if (!method.rate) {
        method.rate = 0;
      }
      if (!method.handling) {
        method.handling = 0;
      }
      // Store shipping provider here in order to have it available in shipmentMethod
      // for cart and order usage
      if (!method.carrier) {
        method.carrier = carrier;
      }
      const rate = method.rate + method.handling;
      rates.push({
        carrier,
        method,
        rate,
        shopId: doc.shopId
      });
    }
  });

  if (rates.length === initialNumOfRates) {
    const errorDetails = {
      requestStatus: "error",
      shippingProvider: "flat-rate-shipping",
      message: "Flat rate shipping did not return any shipping methods."
    };
    rates.push(errorDetails);
    retrialTargets.push(currentMethodInfo);
    return [rates, retrialTargets];
  }

  Logger.debug("Flat rate getShippingPrices", rates);
  return [rates, retrialTargets];
}
