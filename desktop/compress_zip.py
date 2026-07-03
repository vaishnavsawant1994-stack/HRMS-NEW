import os
import zipfile

src_dir = r"d:\Intellisys\HRMS-NEW\desktop\bin\Release\net8.0-windows\win-x64\publish"
dest_zip = r"d:\Intellisys\HRMS-NEW\frontend\public\downloads\HRMS_Agent.zip"

print(f"Compressing {src_dir} to {dest_zip}...")

try:
    dest_dir = os.path.dirname(dest_zip)
    if not os.path.exists(dest_dir):
        os.makedirs(dest_dir)

    if os.path.exists(dest_zip):
        os.remove(dest_zip)

    with zipfile.ZipFile(dest_zip, 'w', zipfile.ZIP_DEFLATED) as zip_file:
        for root, dirs, files in os.walk(src_dir):
            for file in files:
                file_path = os.path.join(root, file)
                rel_path = os.path.relpath(file_path, src_dir)
                zip_file.write(file_path, rel_path)
                
    print("Compression completed successfully!")
except Exception as e:
    print(f"Error during compression: {e}")
    exit(1)
