/** Dueño de la orden (mismo email que el comprador, sin distinguir mayúsculas) o admin. */
const isOrderOwnerOrAdmin = (user, order) => {
  const isOwner = Boolean(user.email) && Boolean(order.buyer_email)
    && user.email.toLowerCase() === order.buyer_email.toLowerCase();
  return isOwner || user.role === 'admin';
};

module.exports = { isOrderOwnerOrAdmin };
