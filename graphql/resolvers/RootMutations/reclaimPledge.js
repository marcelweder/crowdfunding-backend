const logger = require('../../../lib/logger')
const sendPendingPledgeConfirmations = require('../../../lib/sendPendingPledgeConfirmations')

module.exports = async (_, args, {pgdb, req, t}) => {
  // check user
  if (!req.user) {
    logger.error('unauthorized reclaimPledge', { req: req._log(), args })
    throw new Error(t('api/unauthorized'))
  }

  const transaction = await pgdb.transactionBegin()
  try {
    const { pledgeId } = args
    // check pledgeId
    const pledge = await transaction.public.pledges.findOne({id: pledgeId})
    if (!pledge) {
      logger.error(`pledge (${pledgeId}) not found`, { req: req._log(), args, pledge })
      throw new Error(t('api/unexpected'))
    }

    // load original user of pledge
    const pledgeUser = await transaction.public.users.findOne({id: pledge.userId})
    if (pledgeUser.email === req.user.email) {
      logger.info('pledge already belongs to the claiming email', { req: req._log(), args, pledgeUser })
      await transaction.transactionCommit()
      return true
    }
    if (pledgeUser.verified) {
      logger.error('cannot claim pledges of verified users', { req: req._log(), args, pledge })
      throw new Error(t('api/unexpected'))
    }

    // transfer belongings to signedin user
    const newUser = req.user
    const promises = [
      transaction.public.pledges.updateOne({id: pledge.id}, {userId: newUser.id}),
      transaction.public.memberships.update({userId: pledgeUser.id}, {userId: newUser.id}),
      transaction.public.paymentSources.update({userId: pledgeUser.id}, {userId: newUser.id}),
      transaction.public.users.updateOne({id: newUser.id}, {
        firstName: newUser.firstName || pledgeUser.firstName,
        lastName: newUser.lastName || pledgeUser.lastName,
        birthday: newUser.birthday || pledgeUser.birthday,
        addressId: newUser.addressId || pledgeUser.addressId
      })
    ]
    if (pledgeUser.addressId) {
      promises.push(transaction.public.users.updateOne({id: pledgeUser.id}, {addressId: null}))
    }
    await Promise.all(promises)

    // send confirmation mail
    await sendPendingPledgeConfirmations(newUser.id, transaction, t)

    // commit transaction
    await transaction.transactionCommit()

    return true
  } catch (e) {
    await transaction.transactionRollback()
    logger.info('transaction rollback', { req: req._log(), error: e })
    throw e
  }
}
