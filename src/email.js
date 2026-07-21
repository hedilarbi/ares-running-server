const nodemailer = require('nodemailer');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  }
});

const sendOTPEmail = async (email, otpCode) => {
  try {
    const mailOptions = {
      from: `"ARES Running" <${process.env.GMAIL_USER}>`,
      to: email,
      subject: 'ARES Running - Votre code de vérification',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eceef1; border-radius: 10px; background-color: #fafbfc;">
          <div style="text-align: center; margin-bottom: 20px;">
            <h2 style="color: #171b26; font-family: 'Archivo', sans-serif; font-style: italic; font-weight: 900; margin: 0;">ARES <span style="color: #a3d139;">RUNNING</span></h2>
            <p style="font-size: 14px; color: #9aa0ac; margin: 5px 0 0;">Prototype MVP</p>
          </div>
          <div style="padding: 20px; background-color: #ffffff; border-radius: 8px; border: 1px solid #e3e6ea; text-align: center;">
            <p style="font-size: 16px; color: #171b26; margin-bottom: 10px;">Bonjour,</p>
            <p style="font-size: 16px; color: #5a6070; margin-bottom: 20px;">Merci de rejoindre ARES Running. Utilisez le code suivant pour activer votre compte :</p>
            <div style="display: inline-block; font-size: 32px; font-weight: bold; color: #a3d139; background-color: #171b26; padding: 12px 30px; border-radius: 8px; letter-spacing: 5px; margin: 15px 0;">
              ${otpCode}
            </div>
            <p style="font-size: 12px; color: #9aa0ac; margin-top: 20px;">Ce code est valable pendant 10 minutes. Si vous n'avez pas demandé ce code, vous pouvez ignorer cet e-mail.</p>
          </div>
          <div style="text-align: center; margin-top: 20px; font-size: 12px; color: #b3b8c1;">
            &copy; 2026 ARES Running Vision. Tous droits réservés.
          </div>
        </div>
      `
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(`OTP Email sent successfully to ${email}. MessageID: ${info.messageId}`);
    return true;
  } catch (error) {
    console.error(`Failed to send OTP Email to ${email}:`, error.message);
    return false;
  }
};

const sendResetPasswordOTPEmail = async (email, otpCode) => {
  try {
    const mailOptions = {
      from: `"ARES Running" <${process.env.GMAIL_USER}>`,
      to: email,
      subject: 'ARES Running - Réinitialisation de mot de passe',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eceef1; border-radius: 10px; background-color: #fafbfc;">
          <div style="text-align: center; margin-bottom: 20px;">
            <h2 style="color: #171b26; font-family: 'Archivo', sans-serif; font-style: italic; font-weight: 900; margin: 0;">ARES <span style="color: #a3d139;">RUNNING</span></h2>
            <p style="font-size: 14px; color: #9aa0ac; margin: 5px 0 0;">Réinitialisation de mot de passe</p>
          </div>
          <div style="padding: 20px; background-color: #ffffff; border-radius: 8px; border: 1px solid #e3e6ea; text-align: center;">
            <p style="font-size: 16px; color: #171b26; margin-bottom: 10px;">Bonjour,</p>
            <p style="font-size: 16px; color: #5a6070; margin-bottom: 20px;">Vous avez demandé la réinitialisation de votre mot de passe. Utilisez le code ci-dessous pour procéder :</p>
            <div style="display: inline-block; font-size: 32px; font-weight: bold; color: #a3d139; background-color: #171b26; padding: 12px 30px; border-radius: 8px; letter-spacing: 5px; margin: 15px 0;">
              ${otpCode}
            </div>
            <p style="font-size: 12px; color: #9aa0ac; margin-top: 20px;">Ce code est valable pendant 10 minutes. Si vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer cet e-mail en toute sécurité.</p>
          </div>
          <div style="text-align: center; margin-top: 20px; font-size: 12px; color: #b3b8c1;">
            &copy; 2026 ARES Running Vision. Tous droits réservés.
          </div>
        </div>
      `
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(`Reset Password OTP Email sent successfully to ${email}. MessageID: ${info.messageId}`);
    return true;
  } catch (error) {
    console.error(`Failed to send Reset Password OTP Email to ${email}:`, error.message);
    return false;
  }
};

module.exports = { sendOTPEmail, sendResetPasswordOTPEmail };
