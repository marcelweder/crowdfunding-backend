const sendMailTemplate = require('./sendMailTemplate')

module.exports = async (userId, pgdb, t) => {
  const user = await pgdb.public.users.findOne({id: userId})
  const address = await pgdb.public.addresses.findOne({id: user.addressId})

  const pledges = await pgdb.public.pledges.find({
    userId: user.id,
    sendConfirmMail: true
  })

  if(!pledges.length)
    return

  await Promise.all(pledges.map( async (pledge) => {
    const package = await pgdb.public.packages.findOne({id: pledge.packageId})
    const memberships = await pgdb.public.memberships.find({pledgeId: pledge.id})
    const pledgePayment = await pgdb.public.pledgePayments.findFirst({pledgeId: pledge.id}, {orderBy: ['createdAt desc']})
    const payment = await pgdb.public.payments.findOne({id: pledgePayment.paymentId})

    return sendMailTemplate({
      to: user.email,
      fromEmail: process.env.DEFAULT_MAIL_FROM_ADDRESS,
      subject: t('api/pledge/mail/subject'),
      templateName: 'cf_pledge',
      globalMergeVars: [
        { name: 'NAME',
          content: user.name
        },
        { name: 'WAITING_FOR_PAYMENT',
          content: pledge.status==='WAITING_FOR_PAYMENT'
        },
        { name: 'PAPER_INVOICE',
          content: payment.paperInvoice
        },
        { name: 'HRID',
          content: payment.hrid
        },
        { name: 'PAYMENTSLIP',
          content: payment.method==='PAYMENTSLIP'
        },
        { name: 'ASK_PERSONAL_INFO',
          content: (!user.addressId || !user.birthday)
        },
        { name: 'VOUCHER_CODES',
          content: package.name==='ABO_GIVE'
            ? memberships.map( m => m.voucherCode ).join(', ')
            : null
        },
        { name: 'TOTAL',
          content: pledge.total/100.0
        },
        { name: 'ADDRESS',
          content: address
            ? `<span>${address.name}<br/>
${address.line1}<br/>
${address.line2 ? address.line2+'<br/>' : ''}
${address.postalCode} ${address.city}<br/>
${address.country}</span>`
            : null
        },
      ]
    })
  }))

  await pgdb.public.pledges.update({id: pledges.map( pledge => pledge.id )}, {
    sendConfirmMail: false
  })

}