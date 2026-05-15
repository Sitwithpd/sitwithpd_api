// const nodemailer = require('nodemailer');

// const t = nodemailer.createTransport({
//   host: 'mail.sitwithpd.com',
//   port: 465,
//   secure: true,
//   auth: { 
//     user: 'noreply@sitwithpd.com', 
//     pass: 'Noreply@2026' 
//     // pass: 'Justfortoday@2026' 
//   }
// });

// t.verify((err, success) => {
//   if (err) console.error('FAILED:', err.message);
//   else console.log('SUCCESS: SMTP is working');
// });

const nodemailer = require('nodemailer');

const t = nodemailer.createTransport({
  host: 'mail.sitwithpd.com',
  port: 465,
  secure: true,
  auth: { 
    user: 'noreply@sitwithpd.com', 
    pass: 'Noreply@2026'
  }
});

t.sendMail({
  from: 'noreply@sitwithpd.com',
  to: 'nduulenu@gmail.com',
  subject: 'SMTP Test',
  text: 'If you see this, SMTP is working!'
}, (err, info) => {
  if (err) console.error('FAILED:', err.message);
  else console.log('SUCCESS:', info.response);
});