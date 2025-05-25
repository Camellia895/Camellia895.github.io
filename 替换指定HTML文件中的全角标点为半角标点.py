import os
import sys # 用于获取脚本路径

def get_script_directory():
    """获取脚本所在的目录"""
    # 如果脚本被打包成 .exe (例如用 PyInstaller)，sys.executable 是 .exe 的路径
    # 否则，__file__ 是 .py 脚本的路径
    if getattr(sys, 'frozen', False):
        application_path = os.path.dirname(sys.executable)
    else:
        application_path = os.path.dirname(os.path.abspath(__file__))
    return application_path

def replace_full_width_punctuation(file_path):
    """
    替换指定HTML文件中的全角标点为半角标点。

    参数:
    file_path (str): HTML文件的路径。
    """
    replacements = {
        '，': ',',  # 全角逗号
        '。': '.',  # 全角句号
        '！': '!',  # 全角感叹号
        '？': '?',  # 全角问号
        '：': ':',  # 全角冒号
        '；': ';',  # 全角分号
        '（': '(',  # 全角左括号
        '）': ')',  # 全角右括号
        '【': '[',  # 全角左中括号
        '】': ']',  # 全角右中括号
        '“': '"',  # 全角左引号
        '”': '"',  # 全角右引号
        '‘': "'",  # 全角左单引号
        '’': "'",  # 全角右单引号
        '《': '<',  # 全角左书名号
        '》': '>',  # 全角右书名号
        '、': ',',  # 全角顿号
        '　': ' ',  # 全角空格
    }

    try:
        with open(file_path, 'r', encoding='utf-8') as file:
            content = file.read()

        original_content = content
        modified = False

        for full_width, half_width in replacements.items():
            if full_width in content:
                content = content.replace(full_width, half_width)
                modified = True

        if modified:
            with open(file_path, 'w', encoding='utf-8') as file:
                file.write(content)
            print(f"文件 '{os.path.basename(file_path)}' 中的全角标点已成功替换为半角标点。")
        else:
            print(f"文件 '{os.path.basename(file_path)}' 中未检测到需要替换的全角标点，或替换后内容无变化。")

    except FileNotFoundError:
        print(f"错误：文件 '{os.path.basename(file_path)}' 未找到。")
    except Exception as e:
        print(f"处理文件 '{os.path.basename(file_path)}' 时发生错误：{e}")

if __name__ == "__main__":
    script_dir = get_script_directory()
    # 假设要处理的HTML文件名固定为 index.html
    # 如果你想让它处理其他名字的html文件，可以在这里修改 target_html_file 的值
    target_html_file = "index.html"
    html_file_path = os.path.join(script_dir, target_html_file)

    print(f"脚本正在尝试处理位于以下路径的HTML文件：")
    print(html_file_path)
    print("-" * 30) # 分隔线

    if os.path.exists(html_file_path):
        # 在操作前询问用户是否继续，增加一道保险
        # 如果你完全信任这个脚本，并且不希望每次都确认，可以注释掉下面三行
        # confirm = input(f"即将处理文件: {html_file_path}\n是否继续? (y/n): ").lower()
        # if confirm != 'y':
        #     print("操作已取消。")
        # else:
        replace_full_width_punctuation(html_file_path)
    else:
        print(f"错误：在脚本所在目录下未找到 '{target_html_file}' 文件。")
        print("请确保脚本和你的HTML文件（例如 index.html）放在同一个文件夹中。")

    print("-" * 30) # 分隔线
    input("处理完成。按 Enter 键退出...") # 保持窗口打开，直到用户按回车