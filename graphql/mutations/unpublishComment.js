const ensureSignedIn = require('../../lib/ensureSignedIn')
const logger = require('../../lib/logger')
const slack = require('../../lib/slack')

module.exports = async (_, args, {pgdb, user, req, t}) => {
  ensureSignedIn(req, t)

  const { commentId } = args

  const transaction = await pgdb.transactionBegin()
  try {
    //ensure comment exists and belongs to user
    const comment = await transaction.public.comments.findOne({id: commentId})
    if(!comment) {
      logger.error('comment not found', { req: req._log(), commentId })
      throw new Error(t('api/comment/commentNotFound'))
    }
    if(comment.userId !== user.id) {
      logger.error('comment does not belong to user', { req: req._log(), args })
      throw new Error(t('api/comment/notYours'))
    }

    await transaction.public.comments.update({
      id: comment.id,
    }, {
      published: false
    })

    await publish('commentRemoved', comment)
    await slack.publishCommentUnpublish(user, comment)

    await transaction.transactionCommit()
  } catch(e) {
    await transaction.transactionRollback()
    logger.error('error in transaction', { req: req._log(), args, error: e })
    throw e
  }

  return true
}
