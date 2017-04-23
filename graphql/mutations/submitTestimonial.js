const uuid = require('uuid/v4')
const ensureSignedIn = require('../../lib/ensureSignedIn')
const keyCDN = require('../../lib/keyCDN')
const convertImage = require('../../lib/convertImage')
const uploadExoscale = require('../../lib/uploadExoscale')
const logger = require('../../lib/logger')
const renderUrl = require('../../lib/renderUrl')
const sendMailTemplate = require('../../lib/sendMailTemplate')
//const rw = require('rw')

const FOLDER = 'testimonials'
const BUCKET = 'republik'
const IMAGE_SIZE_SMALL = convertImage.IMAGE_SIZE_SMALL
const MAX_QUOTE_LENGTH = 140

module.exports = async (_, args, {loaders, pgdb, user, req, t}) => {
  ensureSignedIn(req, t)

  //check if user has pledged, or was vouchered a memberships
  const hasPledges = await pgdb.public.pledges.count({userId: req.user.id})
  if(!hasPledges && !(await pgdb.public.memberships.count({userId: req.user.id}))) {
    logger.error('not allowed submitTestimonial', { req: req._log(), args, pledge })
    throw new Error(t('api/testimonial/pledge/required'))
  }

  const { role, quote, image } = args
  const { ASSETS_BASE_URL, FRONTEND_BASE_URL } = process.env

  //check quote
  if(quote.trim().length > MAX_QUOTE_LENGTH) {
    logger.error('quote too long', { req: req._log(), args })
    throw new Error(t('testimonial/quote/tooLong'))
  }

  // test with local image
  //const inputFile = rw.readFileSync(__dirname+'/../image.b64', 'utf8')
  //const inputBuffer = new Buffer(inputFile, 'base64')


  const transaction = await pgdb.transactionBegin()
  let sendConfirmEmail = false
  let testimonial
  try {

    testimonial = await transaction.public.testimonials.findOne({userId: req.user.id})
    if(!testimonial || !testimonial.published)
      sendConfirmEmail = true

    if(!testimonial && !image) {
      logger.error('a new testimonials requires an image', { req: req._log(), args })
      throw new Error(t('api/testimonial/image/required'))
    }

    const firstMembership = await pgdb.public.memberships.findFirst({userId: req.user.id}, {orderBy: ['sequenceNumber asc']})
    let seqNumber
    if(firstMembership)
      seqNumber = firstMembership.sequenceNumber

    if(!image) {
      testimonial = await transaction.public.testimonials.updateAndGetOne({id: testimonial.id}, {
        role,
        quote,
        sequenceNumber: testimonial.sequenceNumber || seqNumber
      }, {skipUndefined: true})
    } else { //new image
      const inputBuffer = new Buffer(image, 'base64')
      const id = testimonial ? testimonial.id : uuid()

      const pathOriginal = `/${FOLDER}/${id}_original.jpeg`
      const pathSmall = `/${FOLDER}/${id}_${IMAGE_SIZE_SMALL}x${IMAGE_SIZE_SMALL}.jpeg`

      await Promise.all([
        convertImage.toJPEG(inputBuffer)
          .then( (data) => {
            uploadExoscale({
              stream: data,
              path: pathOriginal,
              mimeType: 'image/jpeg',
              bucket: BUCKET
            })
          }),
        convertImage.toSmallBW(inputBuffer)
          .then( (data) => {
            uploadExoscale({
              stream: data,
              path: pathSmall,
              mimeType: 'image/jpeg',
              bucket: BUCKET
            })
          })
      ])


      if(testimonial) {
        await keyCDN.purgeUrls([pathOriginal, pathSmall])
        testimonial = await transaction.public.testimonials.updateAndGetOne({id: testimonial.id}, {
          role,
          quote,
          image: ASSETS_BASE_URL+pathSmall,
          updatedAt: new Date(),
          published: true,
          sequenceNumber: testimonial.sequenceNumber || seqNumber
        }, {skipUndefined: true})
      } else {
        testimonial = await transaction.public.testimonials.insertAndGet({
          id,
          userId: req.user.id,
          role,
          quote,
          image: ASSETS_BASE_URL+pathSmall,
          published: true,
          sequenceNumber: seqNumber
        }, {skipUndefined: true})
      }
    }

    await transaction.transactionCommit()
  } catch(e) {
    await transaction.transactionRollback()
    logger.info('transaction rollback', { req: req._log(), error: e })
    throw e
  }

  //generate sm picture (PNG!)
  try {
    const smImagePath = `/${FOLDER}/sm/${testimonial.id}_sm.png`
    await renderUrl(`${FRONTEND_BASE_URL}/community?share=${testimonial.id}`, 1200, 628)
      .then( async (data) => {
        return uploadExoscale({
          stream: data,
          path: smImagePath,
          mimeType: 'image/png',
          bucket: BUCKET
        }).then( async () => {
          await keyCDN.purgeUrls([smImagePath])
          return pgdb.public.testimonials.updateAndGetOne({id: testimonial.id}, {
            smImage: ASSETS_BASE_URL+smImagePath
          })
        })
      })
  } catch(e) {
    logger.error('sm image render failed', { req: req._log(), args, e })
    console.error(e)
  }

  if(sendConfirmEmail) {
    await sendMailTemplate({
      to: req.user.email,
      fromEmail: process.env.DEFAULT_MAIL_FROM_ADDRESS,
      subject: t('api/testimonial/mail/subject'),
      templateName: 'cf_community',
      globalMergeVars: [
        { name: 'NAME',
          content: req.user.firstName+' '+req.user.lastName
        },
      ]
    })
  }

  //augement with name
  testimonial.name = `${req.user.firstName} ${req.user.lastName}`

  return testimonial

}