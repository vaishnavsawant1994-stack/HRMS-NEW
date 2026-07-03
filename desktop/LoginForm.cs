using System;
using System.Drawing;
using System.Windows.Forms;

namespace HRMS_Agent
{
    public class LoginForm : Form
    {
        private readonly TextBox _txtApiUrl;
        private readonly TextBox _txtEmail;
        private readonly TextBox _txtPassword;
        private readonly Button _btnLogin;
        private readonly Button _btnCancel;
        private readonly Label _lblStatus;

        public LoginForm()
        {
            Text = "Connect IntelliHrHub Account";
            ClientSize = new Size(380, 265);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(245, 246, 250);
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Shield;

            var titleLabel = new Label
            {
                Text = "IntelliHrHub Desktop Agent",
                Font = new Font("Segoe UI", 12, FontStyle.Bold),
                Location = new Point(20, 15),
                Size = new Size(340, 30),
                ForeColor = Color.FromArgb(47, 54, 64)
            };

            var lblApiUrl = new Label
            {
                Text = "API Server URL:",
                Location = new Point(20, 55),
                Size = new Size(100, 20),
                Font = new Font("Segoe UI", 9)
            };
            _txtApiUrl = new TextBox
            {
                Text = ApiSync.ApiUrl,
                Location = new Point(130, 52),
                Size = new Size(210, 23),
                Font = new Font("Segoe UI", 9)
            };

            var lblEmail = new Label
            {
                Text = "Email Address:",
                Location = new Point(20, 90),
                Size = new Size(100, 20),
                Font = new Font("Segoe UI", 9)
            };
            _txtEmail = new TextBox
            {
                Text = ApiSync.CurrentEmail,
                Location = new Point(130, 87),
                Size = new Size(210, 23),
                Font = new Font("Segoe UI", 9)
            };

            var lblPassword = new Label
            {
                Text = "Password:",
                Location = new Point(20, 125),
                Size = new Size(100, 20),
                Font = new Font("Segoe UI", 9)
            };
            _txtPassword = new TextBox
            {
                Location = new Point(130, 122),
                Size = new Size(210, 23),
                PasswordChar = '●',
                Font = new Font("Segoe UI", 9)
            };

            _lblStatus = new Label
            {
                Text = "Enter your credentials to sync attendance.",
                Location = new Point(20, 160),
                Size = new Size(340, 35),
                Font = new Font("Segoe UI", 8.5f, FontStyle.Italic),
                ForeColor = Color.FromArgb(127, 140, 141)
            };

            _btnLogin = new Button
            {
                Text = "Connect",
                Location = new Point(140, 210),
                Size = new Size(100, 32),
                BackColor = Color.FromArgb(9, 132, 227),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Segoe UI", 9, FontStyle.Bold)
            };
            _btnLogin.FlatAppearance.BorderSize = 0;
            _btnLogin.Click += OnLoginClick;

            _btnCancel = new Button
            {
                Text = "Cancel",
                Location = new Point(250, 210),
                Size = new Size(100, 32),
                BackColor = Color.FromArgb(220, 221, 230),
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Segoe UI", 9)
            };
            _btnCancel.FlatAppearance.BorderSize = 0;
            _btnCancel.Click += (s, e) => Close();

            var lblVersion = new Label
            {
                Text = "Version 2.1",
                Font = new Font("Segoe UI", 8.5f, FontStyle.Regular),
                ForeColor = Color.FromArgb(127, 140, 141),
                Location = new Point(20, 245),
                Size = new Size(100, 15),
                TextAlign = ContentAlignment.MiddleLeft
            };

            Controls.AddRange(new Control[] {
                titleLabel, lblApiUrl, _txtApiUrl, lblEmail, _txtEmail, lblPassword, _txtPassword,
                _lblStatus, _btnLogin, _btnCancel, lblVersion
            });

            AcceptButton = _btnLogin;
            CancelButton = _btnCancel;
        }

        private async void OnLoginClick(object? sender, EventArgs e)
        {
            string apiUrl = _txtApiUrl.Text.Trim();
            string email = _txtEmail.Text.Trim();
            string password = _txtPassword.Text;

            if (string.IsNullOrEmpty(apiUrl) || string.IsNullOrEmpty(email) || string.IsNullOrEmpty(password))
            {
                _lblStatus.Text = "Please fill in all fields.";
                _lblStatus.ForeColor = Color.Red;
                return;
            }

            _lblStatus.Text = "Connecting to server...";
            _lblStatus.ForeColor = Color.FromArgb(9, 132, 227);
            _btnLogin.Enabled = false;

            ApiSync.SetApiUrl(apiUrl);
            bool success = await ApiSync.LoginAsync(email, password);

            _btnLogin.Enabled = true;

            if (success)
            {
                DialogResult = DialogResult.OK;
                Close();
            }
            else
            {
                _lblStatus.Text = "Login failed. Check server URL or credentials.";
                _lblStatus.ForeColor = Color.Red;
            }
        }
    }
}
